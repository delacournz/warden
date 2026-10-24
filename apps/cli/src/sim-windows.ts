import { type Exec, execError } from "@delacour/warden-core/exec";
import { probeIosWarm, realTimer, type Timer } from "@delacour/warden-core/providers/health";
import { IOS_TIMEOUTS } from "@delacour/warden-core/providers/ios";
import { parseAllSims } from "@delacour/warden-core/sims/list";
import type { Store } from "@delacour/warden-core/store";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";

/** A Simulator.app device window: title `<device name> – <runtime>`, size in points. */
export type SimWindow = { title: string; width: number; height: number };

/** Usable screen area in top-left-origin points (menu bar + Dock excluded). */
export type ScreenArea = { x: number; y: number; width: number; height: number };

export type WindowMove = { title: string; x: number; y: number };

const GAP = 8;
const WARDEN_PREFIX = "warden-";
const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** `warden-iphone-17-1 – iOS 26.5` → `warden-iphone-17-1`. */
export function deviceName(title: string): string {
	return title.split(" – ")[0] ?? title;
}

/**
 * Lay warden sims out in natural name order (`-2` before `-10`), left to right then top to bottom.
 * Simulator windows can't be resized, so a row too wide for the screen overlaps evenly — each
 * window covers only the right edge of the one before, keeping every title bar readable. Rows wrap
 * only while they still fit vertically. The result is in raise order (later windows on top).
 */
export function layoutWindows(windows: readonly SimWindow[], screen: ScreenArea): WindowMove[] {
	const sims = windows
		.filter((w) => w.title.startsWith(WARDEN_PREFIX))
		.sort((a, b) => naturalOrder.compare(deviceName(a.title), deviceName(b.title)));
	if (sims.length === 0) return [];
	const cellWidth = Math.max(...sims.map((w) => w.width)) + GAP;
	const cellHeight = Math.max(...sims.map((w) => w.height)) + GAP;
	const perRow = Math.max(1, Math.floor((screen.width + GAP) / cellWidth));
	const maxRows = Math.max(1, Math.floor((screen.height + GAP) / cellHeight));
	const rows = Math.min(maxRows, Math.ceil(sims.length / perRow));
	const cols = Math.ceil(sims.length / rows);

	const moves: WindowMove[] = [];
	for (let r = 0; r < rows; r++) {
		const row = sims.slice(r * cols, (r + 1) * cols);
		const y = screen.y + r * cellHeight;
		const fullWidth = row.reduce((sum, w) => sum + w.width, 0) + GAP * (row.length - 1);
		const overlap = fullWidth > screen.width && row.length > 1 ? (fullWidth - screen.width) / (row.length - 1) : 0;
		let x = screen.x;
		for (const w of row) {
			moves.push({ title: w.title, x: Math.round(x), y });
			x += w.width + GAP - overlap;
		}
	}
	return moves;
}

/** The viewer apps whose per-device windows warden can arrange or close. */
type WindowViewer = Exclude<SimViewer["kind"], "none">;

/**
 * Device Hub's per-device windows carry this `AXIdentifier` prefix. Its management window is titled
 * with the selected device's name in the same `<name> – iOS <ver>` format (verified on Xcode 27.1),
 * so a `warden-` title prefix would tile it: windows are told apart by identifier, not title.
 */
const DEVICE_HUB_WINDOW_ID = "deviceWindow-";

const PROCESS_NAME: Record<WindowViewer, string> = { simulator: "Simulator", "device-hub": "DeviceHub" };

/** JS predicate over a System Events window `w`: Simulator.app has only device windows; Device Hub also has a management window. */
const KEEP_WINDOW: Record<WindowViewer, string> = {
	simulator: "true",
	"device-hub": `String(w.attributes.byName("AXIdentifier").value()).startsWith("${DEVICE_HUB_WINDOW_ID}")`,
};

/** JXA: the viewer's device windows + the menu-bar screen's visible frame, flipped to top-left origin. */
function readScript(viewer: WindowViewer): string {
	const keep = viewer === "simulator" ? "" : `.filter((w) => ${KEEP_WINDOW[viewer]})`;
	return `ObjC.import("AppKit");
function run() {
	const s = $.NSScreen.screens.objectAtIndex(0);
	const f = s.frame, v = s.visibleFrame;
	const screen = { x: v.origin.x, y: f.size.height - (v.origin.y + v.size.height), width: v.size.width, height: v.size.height };
	const procs = Application("System Events").processes.whose({ name: "${PROCESS_NAME[viewer]}" });
	const windows = procs.length === 0 ? [] : procs[0].windows()${keep}.map((w) => {
		const size = w.size();
		return { title: w.name() || "", width: size[0], height: size[1] };
	});
	return JSON.stringify({ screen, windows });
}`;
}

/** JXA: move each window (argv[0] = WindowMove[] JSON) and raise it, in order. */
function moveScript(viewer: WindowViewer): string {
	if (viewer === "simulator") {
		return `function run(argv) {
	const proc = Application("System Events").processes.byName("Simulator");
	for (const m of JSON.parse(argv[0])) {
		const w = proc.windows.byName(m.title);
		w.position = [m.x, m.y];
		w.actions.byName("AXRaise").perform();
	}
	return "";
}`;
	}
	return `function run(argv) {
	const proc = Application("System Events").processes.byName("${PROCESS_NAME[viewer]}");
	const windows = proc.windows().filter((w) => ${KEEP_WINDOW[viewer]});
	for (const m of JSON.parse(argv[0])) {
		const w = windows.find((c) => c.name() === m.title);
		if (!w) continue;
		w.position = [m.x, m.y];
		w.actions.byName("AXRaise").perform();
	}
	return "";
}`;
}

/**
 * JXA: close each named Simulator.app window (argv[0] = title[] JSON) with its close button; a missing
 * one is skipped. Device Hub opens no window by itself, so headless never closes any there.
 */
const CLOSE_SCRIPT = `function run(argv) {
	const procs = Application("System Events").processes.whose({ name: "Simulator" });
	if (procs.length === 0) return "";
	const proc = procs[0];
	for (const title of JSON.parse(argv[0])) {
		const found = proc.windows.whose({ name: title });
		if (found.length === 0) continue;
		const close = found[0].buttons.whose({ subrole: "AXCloseButton" });
		if (close.length > 0) close[0].click();
	}
	return "";
}`;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null;
}

function parseRead(stdout: string): Result<{ screen: ScreenArea; windows: SimWindow[] }> {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return err(`couldn't parse Simulator window list: ${stdout.trim().slice(0, 80)}`);
	}
	if (!isRecord(data) || !isRecord(data.screen) || !Array.isArray(data.windows)) {
		return err("unexpected Simulator window list shape");
	}
	const { x, y, width, height } = data.screen;
	if (!isNum(x) || !isNum(y) || !isNum(width) || !isNum(height)) return err("unexpected screen frame");
	const windows: SimWindow[] = [];
	for (const w of data.windows) {
		if (isRecord(w) && typeof w.title === "string" && isNum(w.width) && isNum(w.height)) {
			windows.push({ title: w.title, width: w.width, height: w.height });
		}
	}
	return ok({ screen: { x, y, width, height }, windows });
}

const osascript = (exec: Exec, script: string, ...args: string[]) =>
	exec(["osascript", "-l", "JavaScript", "-e", script, ...args], { timeoutMs: 15_000 });

/**
 * The simulator viewer running on this Mac. Xcode ≤ 26: Simulator.app (process `Simulator`), one
 * window per booted device, which warden tiles or closes. Xcode 27 removed it for Device Hub
 * (`Xcode.app/Contents/Applications/DeviceHub.app`, `com.apple.dt.Devices`, process `DeviceHub`),
 * which also has a window per device (System Events sees them; verified on Xcode 27.1). warden does
 * not tile or close those yet: under Device Hub it leaves every window alone.
 */
export type SimViewer = { kind: "simulator" } | { kind: "device-hub" } | { kind: "none" };

const NOT_RUNNING = 1;

/**
 * Which viewer is running, by process rather than by Xcode version: the windows belong to whichever
 * app is up, and a Mac can have Xcode 26 and 27 side by side. `pgrep -xq` (~10 ms) answers before an
 * osascript JXA start (35 ms and up) is spent asking an app that is not there — the usual case for a
 * headless run. Only a plain "no match" (exit 1) says no; any other outcome of the Simulator probe
 * (pgrep missing or failing) means "Simulator.app, ask osascript", as before Device Hub existed.
 */
export async function detectSimViewer(exec: Exec): Promise<SimViewer> {
	if ((await exec(["pgrep", "-xq", "Simulator"])).exitCode !== NOT_RUNNING) return { kind: "simulator" };
	if ((await exec(["pgrep", "-xq", "DeviceHub"])).exitCode === 0) return { kind: "device-hub" };
	return { kind: "none" };
}

function scriptError(cmd: string, result: { exitCode: number; stdout: string; stderr: string }): string {
	const hint = /assistive|-1719|-25211|not allowed/i.test(result.stderr)
		? " — allow your terminal in System Settings → Privacy & Security → Accessibility"
		: "";
	return `${execError(["osascript", cmd], result)}${hint}`;
}

/** What `arrangeSimWindows` did, and which viewer it found. */
export type Arranged = { arranged: string[]; viewer: SimViewer["kind"] };

/**
 * Tile open Simulator.app / Device Hub windows of warden sims in name order (macOS, via System
 * Events). Never launches a viewer: no windows → nothing to do. Returns the device names it arranged.
 */
export async function arrangeSimWindows(exec: Exec): AsyncResult<Arranged> {
	const { kind: viewer } = await detectSimViewer(exec);
	if (viewer === "none") return ok({ arranged: [], viewer });
	const read = await osascript(exec, readScript(viewer));
	if (read.exitCode !== 0) return err(scriptError("(read windows)", read));
	const parsed = parseRead(read.stdout);
	if (!parsed.success) return parsed;
	const moves = layoutWindows(parsed.data.windows, parsed.data.screen);
	if (moves.length === 0) return ok({ arranged: [], viewer });
	const moved = await osascript(exec, moveScript(viewer), JSON.stringify(moves));
	if (moved.exitCode !== 0) return err(scriptError("(move windows)", moved));
	return ok({ arranged: moves.map((m) => deviceName(m.title)), viewer });
}

export type AutoArrangeDeps = {
	exec: Exec;
	env: Record<string, string | undefined>;
	os?: NodeJS.Platform;
	sleep?: (ms: number) => Promise<void>;
};

const SETTLE_TRIES = 6;
const SETTLE_MS = 500;

/**
 * After a claim: best-effort arrange (macOS, unless `WARDEN_ARRANGE=0`). A freshly booted sim's
 * window can lag the boot, so while Simulator.app is showing windows but not yet every device in
 * `claimed`, retry briefly. `claimed` is who to wait for: the sims this claim booted — a sim that
 * was already running keeps whatever window (or none, when it booted headless) it had, so waiting
 * for it would only burn the retries. Errors are swallowed — window layout never fails a claim.
 */
export async function autoArrangeSimWindows(deps: AutoArrangeDeps, claimed: readonly string[]): Promise<void> {
	if ((deps.os ?? process.platform) !== "darwin" || deps.env.WARDEN_ARRANGE === "0") return;
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	for (let attempt = 1; ; attempt++) {
		const result = await arrangeSimWindows(deps.exec);
		if (!result.success || result.data.arranged.length === 0) return;
		const { arranged } = result.data;
		if (claimed.every((name) => arranged.includes(name)) || attempt >= SETTLE_TRIES) return;
		await sleep(SETTLE_MS);
	}
}

/** A device this run leased: closing windows is limited to these names. */
export type LeasedSim = { udid: string; name: string };

export type HideDeps = {
	exec: Exec;
	/** headless never fails a run: problems come out here */
	warn: (line: string) => void;
	/** a device the window close shut down, before it is booted again: whatever is bound to its old boot (a resident `warden-simd`) must go */
	onShutDown?: (udid: string) => Promise<void>;
	os?: NodeJS.Platform;
	sleep?: (ms: number) => Promise<void>;
	/** arbitrates Simulator.app's machine-global close setting with every other warden process; without it, this hide alone owns it */
	detachLock?: DetachLock;
	/** the warm probe's timeout timer (tests resolve it at once) */
	timer?: (ms: number) => Timer;
};

/** The shared store and liveness check behind `DetachOnWindowClose` arbitration (`DETACH_PREF_META`). */
export type DetachLock = {
	store: Pick<Store, "transaction" | "getMeta" | "setMeta" | "deleteMeta">;
	/** this process: a holder whose pid is gone is dropped */
	pid: number;
	pidAlive: (pid: number) => boolean;
	/** the clock for the row's timestamps (`DETACH_ROW_TTL_MS`); defaults to `Date.now` */
	now?: () => number;
};

/** `failed`: devices the close shut down whose `bootstatus -b` or warm probe failed (only set when there are any). */
export type HideOutcome = { closed: string[]; rebooted: string[]; failed?: string[] };

/**
 * A hide in two steps. The promise of it resolves once the windows are closed (fast: no shutdown, no
 * reboot). `down` then names the leased devices that the close shut down anyway (after a short settle
 * and a `simctl list`): only those must wait for `settled`, which follows their reboot and the
 * setting's restore. Neither promise rejects.
 */
export type HideStart = { closed: string[]; down: Promise<LeasedSim[]>; settled: Promise<HideOutcome> };

/** a closed window can take a moment to shut its device down */
const CLOSE_SETTLE_MS = 500;
/** how long to wait for a device that is still `Shutting Down` before booting it again */
const SHUTDOWN_POLLS = 40;
const SHUTDOWN_POLL_MS = 500;
const BOOT_TIMEOUT_MS = 180_000;

/**
 * Simulator.app's "when closing a window" setting: unset / false = shut the device down, true =
 * detach and keep it running. Headless needs the latter, so it is switched on for the close and
 * then put back exactly as it was.
 */
const DETACH_PREF = ["com.apple.iphonesimulator", "DetachOnWindowClose"] as const;

type DetachPref = "unset" | "on" | "off";

async function readDetachPref(exec: Exec): Promise<DetachPref> {
	const out = await exec(["defaults", "read", ...DETACH_PREF]);
	if (out.exitCode !== 0) return "unset";
	const value = out.stdout.trim();
	if (value === "1") return "on";
	return value === "0" ? "off" : "unset";
}

async function restoreDetachPref(deps: HideDeps, before: DetachPref): Promise<void> {
	if (before === "on") return;
	const argv =
		before === "off" ? ["defaults", "write", ...DETACH_PREF, "-bool", "false"] : ["defaults", "delete", ...DETACH_PREF];
	const out = await deps.exec(argv);
	if (out.exitCode !== 0) deps.warn(`headless: couldn't restore Simulator's close setting: ${execError(argv, out)}`);
}

/** meta row arbitrating `DetachOnWindowClose` across warden processes */
export const DETACH_PREF_META = "headless.detach_pref";
/** how long a hide waits for another process to finish writing or restoring the setting */
const DETACH_WAIT_POLLS = 200;
const DETACH_POLL_MS = 50;
/**
 * Longer than any step between two heartbeats of a hide holding the setting (`beatStep`: after the
 * close, each shutdown poll, `simctl boot`, `bootstatus -b` + probe, each reboot), each of them bounded.
 * A holder silent for longer is gone even if its pid is alive again (reused), an older
 * `setting`/`restoring` is not waited on, and an older crash's `before` is not written back.
 */
const DETACH_ROW_TTL_MS = BOOT_TIMEOUT_MS + 120_000;

/**
 * `setting`: `by` is reading the user's value and switching it on; `set`: on, with `before` the
 * user's value; `restoring`: the last holder `by` is putting `before` back. `holders` are the hides
 * relying on it being on. `at`: when the phase began (or `by`'s last heartbeat); a holder's `at`: its
 * last heartbeat, or when it joined (epoch ms).
 */
type DetachHolder = { token: string; pid: number; at?: number };
type DetachRow = {
	phase: "setting" | "set" | "restoring";
	before?: DetachPref;
	by: string;
	at?: number;
	holders: DetachHolder[];
};

function parseDetachRow(raw: string | undefined): DetachRow | undefined {
	if (raw === undefined) return undefined;
	try {
		const data: unknown = JSON.parse(raw);
		if (!isRecord(data) || !Array.isArray(data.holders) || typeof data.by !== "string") return undefined;
		const phase = data.phase;
		if (phase !== "setting" && phase !== "set" && phase !== "restoring") return undefined;
		const holders = data.holders.flatMap((h: unknown): DetachHolder[] =>
			isRecord(h) && typeof h.token === "string" && isNum(h.pid)
				? [isNum(h.at) ? { token: h.token, pid: h.pid, at: h.at } : { token: h.token, pid: h.pid }]
				: []
		);
		const before = data.before;
		const row: DetachRow = { phase, by: data.by, holders };
		if (before === "unset" || before === "on" || before === "off") row.before = before;
		if (isNum(data.at)) row.at = data.at;
		return row;
	} catch {
		return undefined;
	}
}

/** Holder tokens are `<pid>:<uuid>`, so a `by` names its process even once it left the holders. */
function tokenPid(token: string): number | undefined {
	const pid = Number(token.split(":")[0]);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

const lockNow = (lock: DetachLock) => (lock.now ?? Date.now)();

/** Was `at` (a row's or holder's timestamp; missing = unknown) within `DETACH_ROW_TTL_MS`? */
function recent(lock: DetachLock, at: number | undefined): boolean {
	return at !== undefined && lockNow(lock) - at <= DETACH_ROW_TTL_MS;
}

/** A holder still relying on the setting: its process is alive and it joined recently enough. */
const holderLive = (lock: DetachLock, h: DetachHolder) => lock.pidAlive(h.pid) && recent(lock, h.at);

type Acquired = { kind: "first"; inherited?: DetachPref } | { kind: "joined" } | { kind: "wait"; joined: boolean };

/**
 * One step of joining the setting's holders, under `BEGIN IMMEDIATE`. Holders (and a `by`) whose
 * process is gone, or that are older than `DETACH_ROW_TTL_MS`, are dropped; a recent dead holder's
 * recorded `before` is offered as `inherited`, so the user's value is still put back after a crash.
 */
function joinStep(lock: DetachLock, token: string, joined: boolean): Acquired {
	return lock.store.transaction((): Acquired => {
		const row = parseDetachRow(lock.store.getMeta(DETACH_PREF_META));
		const save = (next: DetachRow) => lock.store.setMeta(DETACH_PREF_META, JSON.stringify(next));
		const me = { token, pid: lock.pid, at: lockNow(lock) };
		const live = (row?.holders ?? []).filter((h) => h.token !== token && holderLive(lock, h));
		const step = row && joinLive(lock, row, live.length > 0);
		if (row && step) {
			const holds = step.kind === "joined" || (step.kind === "wait" && step.joined);
			if (holds && !joined) save({ ...row, holders: [...live, me] });
			return step;
		}
		// nobody (alive) relies on it: this hide switches it on, inheriting a dead holder's `before`
		save({ phase: "setting", by: token, at: me.at, holders: [...live, me] });
		const inherited = row && inheritable(lock, row);
		return inherited !== undefined ? { kind: "first", inherited } : { kind: "first" };
	});
}

/** A taken-over row's `before`, unless the row was last touched longer ago than `DETACH_ROW_TTL_MS`. */
function inheritable(lock: DetachLock, row: DetachRow): DetachPref | undefined {
	const touched = Math.max(row.at ?? 0, ...row.holders.map((h) => h.at ?? 0));
	return recent(lock, touched) ? row.before : undefined;
}

/** What a hide does with a row someone alive is behind; undefined: nobody is, take it over. */
function joinLive(lock: DetachLock, row: DetachRow, othersHold: boolean): Acquired | undefined {
	const byPid = tokenPid(row.by);
	const byAlive = byPid !== undefined && lock.pidAlive(byPid) && recent(lock, row.at);
	if (row.phase === "restoring" && byAlive) return { kind: "wait", joined: false };
	if (row.phase === "setting" && byAlive) return { kind: "wait", joined: true };
	if (row.phase === "set" && othersHold) return { kind: "joined" };
	return undefined;
}

/** Mark the setting on (the first holder, done writing it). */
function markSet(lock: DetachLock, token: string, before: DetachPref): void {
	lock.store.transaction(() => {
		const row = parseDetachRow(lock.store.getMeta(DETACH_PREF_META));
		const at = lockNow(lock);
		const holders = row?.holders ?? [{ token, pid: lock.pid, at }];
		lock.store.setMeta(DETACH_PREF_META, JSON.stringify({ phase: "set", before, by: token, at, holders }));
	});
}

/** Leave; the last live holder gets the user's value back to restore (and the row turns `restoring`). */
function leaveStep(lock: DetachLock, token: string): DetachPref | undefined {
	return lock.store.transaction(() => {
		const row = parseDetachRow(lock.store.getMeta(DETACH_PREF_META));
		// not a holder (gave up waiting before it could join): nothing of this hide's to restore
		if (!row?.holders.some((h) => h.token === token)) return undefined;
		const rest = row.holders.filter((h) => h.token !== token && holderLive(lock, h));
		if (rest.length > 0) {
			lock.store.setMeta(DETACH_PREF_META, JSON.stringify({ ...row, holders: rest }));
			return undefined;
		}
		lock.store.setMeta(
			DETACH_PREF_META,
			JSON.stringify({ ...row, phase: "restoring", by: token, at: lockNow(lock), holders: [] })
		);
		return row.before ?? "unset";
	});
}

/** A holding hide is still at it: re-stamp its holder `at` (and the row's, when it is `by`). */
function beatStep(lock: DetachLock, token: string): void {
	lock.store.transaction(() => {
		const row = parseDetachRow(lock.store.getMeta(DETACH_PREF_META));
		if (!row?.holders.some((h) => h.token === token)) return;
		const at = lockNow(lock);
		const holders = row.holders.map((h) => (h.token === token ? { ...h, at } : h));
		const next = row.by === token ? { ...row, at, holders } : { ...row, holders };
		lock.store.setMeta(DETACH_PREF_META, JSON.stringify(next));
	});
}

/** A held setting: `release` puts it back (when last out), `beat` tells other processes this hide still relies on it. */
type DetachHold = { release: () => Promise<void>; beat: () => void };

function finishRestore(lock: DetachLock, token: string): void {
	lock.store.transaction(() => {
		const row = parseDetachRow(lock.store.getMeta(DETACH_PREF_META));
		if (row?.phase === "restoring" && row.by === token) lock.store.deleteMeta(DETACH_PREF_META);
	});
}

/** The first holder: read the user's value, switch it on, and record what to put back. */
async function switchOn(deps: HideDeps, lock: DetachLock, token: string, inherited: DetachPref | undefined) {
	const read = await readDetachPref(deps.exec);
	// a dead holder's value only explains an `on` it left behind; anything else is the user's own
	const before = inherited !== undefined && read === "on" ? inherited : read;
	if (read !== "on") await deps.exec(["defaults", "write", ...DETACH_PREF, "-bool", "true"]);
	markSet(lock, token, before);
}

/**
 * Switch `DetachOnWindowClose` on for this hide; the returned release puts the user's value back when
 * this hide is the last one relying on it. With a `detachLock`, every warden process shares one
 * reference count (meta row `DETACH_PREF_META`, arbitrated by `store.transaction`): the first holder
 * reads and writes, later ones join, the last one out restores.
 */
async function holdDetachPref(deps: HideDeps): Promise<DetachHold> {
	const lock = deps.detachLock;
	if (!lock) {
		const before = await readDetachPref(deps.exec);
		if (before !== "on") await deps.exec(["defaults", "write", ...DETACH_PREF, "-bool", "true"]);
		return { release: () => restoreDetachPref(deps, before), beat: () => {} };
	}
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	const token = `${lock.pid}:${crypto.randomUUID()}`;
	let joined = false;
	for (let i = 0; ; i++) {
		const step = joinStep(lock, token, joined);
		if (step.kind === "first") {
			await switchOn(deps, lock, token, step.inherited);
			break;
		}
		if (step.kind === "joined") break;
		joined = step.joined;
		if (i >= DETACH_WAIT_POLLS) {
			deps.warn("headless: another warden is still changing Simulator's close setting — closing anyway");
			break;
		}
		await sleep(DETACH_POLL_MS);
	}
	return {
		release: async () => {
			const before = leaveStep(lock, token);
			if (before === undefined) return;
			await restoreDetachPref(deps, before);
			finishRestore(lock, token);
		},
		beat: () => beatStep(lock, token),
	};
}

/**
 * Titles of the open Simulator.app windows that belong to `sims`; undefined after a warned error.
 * Device Hub (Xcode 27) windows are not closed yet: under Device Hub this returns none.
 */
async function leasedTitles(deps: HideDeps, sims: readonly LeasedSim[]): Promise<string[] | undefined> {
	if ((await detectSimViewer(deps.exec)).kind !== "simulator") return [];
	const read = await osascript(deps.exec, readScript("simulator"));
	if (read.exitCode !== 0) {
		deps.warn(`headless: ${scriptError("(read windows)", read)}`);
		return undefined;
	}
	const parsed = parseRead(read.stdout);
	if (!parsed.success) {
		deps.warn(`headless: ${parsed.error}`);
		return undefined;
	}
	const names = new Set(sims.map((s) => s.name));
	return parsed.data.windows.map((w) => w.title).filter((title) => names.has(deviceName(title)));
}

async function closeTitles(deps: HideDeps, titles: readonly string[]): Promise<boolean> {
	const closed = await osascript(deps.exec, CLOSE_SCRIPT, JSON.stringify(titles));
	if (closed.exitCode === 0) return true;
	deps.warn(`headless: ${scriptError("(close windows)", closed)}`);
	return false;
}

/**
 * Headless: close the Simulator.app windows of the leased devices (matched by `deviceName(title)`,
 * never another device's), macOS only. Never launches a viewer — not running → nothing to do; Device
 * Hub (Xcode 27) → nothing to do either (`leasedTitles`).
 * The close detaches (Simulator's `DetachOnWindowClose`, restored afterwards — by the last of
 * concurrent hides when `detachLock` is given), so the device keeps running; ones that shut down
 * anyway are booted again in parallel without a window (`simctl boot` + `bootstatus -b`, then the
 * warm probe) and a window Simulator.app reattached to them is closed once more.
 * Never fails: errors go to `warn`.
 */
export async function hideSimWindows(deps: HideDeps, sims: readonly LeasedSim[]): Promise<HideOutcome> {
	return (await startHideSimWindows(deps, sims)).settled;
}

/** `hideSimWindows` in two steps (see `HideStart`): the caller can go on with the devices that stayed up once `down` resolves. */
export async function startHideSimWindows(deps: HideDeps, sims: readonly LeasedSim[]): Promise<HideStart> {
	const idle: HideStart = {
		closed: [],
		down: Promise.resolve([]),
		settled: Promise.resolve({ closed: [], rebooted: [] }),
	};
	if ((deps.os ?? process.platform) !== "darwin" || sims.length === 0) return idle;
	const titles = await leasedTitles(deps, sims);
	if (!titles || titles.length === 0) return idle;
	const { release, beat } = await holdDetachPref(deps);
	let closedOk = false;
	try {
		closedOk = await closeTitles(deps, titles);
	} finally {
		if (!closedOk) await release();
	}
	if (!closedOk) return idle;
	beat();
	const closed = titles.map(deviceName);
	const down = shutDownByClose(
		deps,
		sims.filter((s) => closed.includes(s.name)),
		beat
	);
	const settled = (async (): Promise<HideOutcome> => {
		try {
			const { rebooted, failed } = await rebootAll(deps, await down, beat);
			if (rebooted.length > 0) {
				const again = await leasedTitles(
					deps,
					sims.filter((s) => rebooted.includes(s.name))
				);
				if (again && again.length > 0) await closeTitles(deps, again);
			}
			return failed.length > 0 ? { closed, rebooted, failed } : { closed, rebooted };
		} finally {
			await release();
		}
	})();
	return { closed, down, settled };
}

/** `simctl list` states by udid; undefined after a warned error. */
async function simStates(deps: HideDeps): Promise<Map<string, string> | undefined> {
	const list = await deps.exec(["xcrun", "simctl", "list", "devices", "-j"], { timeoutMs: IOS_TIMEOUTS.listMs });
	const all = list.exitCode === 0 ? parseAllSims(list.stdout) : undefined;
	if (all?.success) return new Map(all.data.map((d) => [d.udid, d.state]));
	deps.warn(`headless: couldn't check device states after closing windows: ${all ? all.error : list.stderr.trim()}`);
	return undefined;
}

/** Which of `sims` are no longer `Booted` after their window closed, once they finished shutting down. */
async function shutDownByClose(deps: HideDeps, sims: readonly LeasedSim[], beat: () => void): Promise<LeasedSim[]> {
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	await sleep(CLOSE_SETTLE_MS);
	let states = await simStates(deps);
	beat();
	// `simctl boot` refuses a device that is still shutting down
	for (let i = 0; states && i < SHUTDOWN_POLLS && sims.some((s) => states?.get(s.udid) === "Shutting Down"); i++) {
		await sleep(SHUTDOWN_POLL_MS);
		states = await simStates(deps);
		beat();
	}
	if (!states) return [];
	return sims.filter((s) => states?.get(s.udid) !== "Booted");
}

/** `simctl boot` of a device that is already up exits non-zero with this; it is not a failure. */
const ALREADY_BOOTED = /current state: Booted/;

/** Boot one shut-down device again (headless) and probe it; false after a warned `bootstatus` or probe failure. */
async function rebootOne(deps: HideDeps, sim: LeasedSim, beat: () => void): Promise<boolean> {
	deps.warn(`headless: closing ${sim.name}'s window shut it down — booting it again without a window`);
	await deps.onShutDown?.(sim.udid);
	const bootArgv = ["xcrun", "simctl", "boot", sim.udid];
	const boot = await deps.exec(bootArgv, { timeoutMs: IOS_TIMEOUTS.bootMs });
	beat();
	// not fatal: `bootstatus -b` boots the device itself (one still `Shutting Down`, a transient refusal)
	if (boot.exitCode !== 0 && !ALREADY_BOOTED.test(boot.stderr)) {
		deps.warn(`headless: ${sim.name}: ${execError(bootArgv, boot)} — waiting for bootstatus to boot it`);
	}
	const statusArgv = ["xcrun", "simctl", "bootstatus", sim.udid, "-b"];
	const ready = await deps.exec(statusArgv, { timeoutMs: BOOT_TIMEOUT_MS });
	if (ready.exitCode !== 0) {
		deps.warn(`headless: ${sim.name}: ${execError(statusArgv, ready)}`);
		return false;
	}
	const probe = await probeIosWarm({ exec: deps.exec, timer: deps.timer ?? realTimer }, sim.udid);
	if (!probe.success) {
		deps.warn(`headless: ${sim.name} booted again but is not healthy: ${probe.error}`);
		return false;
	}
	return true;
}

/** Boot `down` again in parallel; names that came back healthy, and those that did not. */
async function rebootAll(
	deps: HideDeps,
	down: readonly LeasedSim[],
	beat: () => void
): Promise<{ rebooted: string[]; failed: string[] }> {
	const results = await Promise.all(
		down.map(async (sim) => {
			const ok = await rebootOne(deps, sim, beat);
			beat();
			return { name: sim.name, ok };
		})
	);
	return {
		rebooted: results.filter((r) => r.ok).map((r) => r.name),
		failed: results.filter((r) => !r.ok).map((r) => r.name),
	};
}
