import { IosHealth, type Timer, timers } from "@delacour/warden-providers/health";
import { IOS_TIMEOUTS } from "@delacour/warden-providers/ios";
import { simctlListParser } from "@delacour/warden-providers/simctl-list";
import { type Exec, execErrors } from "@delacour/warden-runtime/exec";
import type { Store } from "@delacour/warden-store/store";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";

/** A Simulator.app device window: title `<device name> – <runtime>`, size in points. */
export type SimWindow = { title: string; width: number; height: number };

/** Usable screen area in top-left-origin points (menu bar + Dock excluded). */
export type ScreenArea = { x: number; y: number; width: number; height: number };

export type WindowMove = { title: string; x: number; y: number };

const GAP = 8;
const WARDEN_PREFIX = "warden-";
const naturalOrder = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/**
 * The simulator viewer running on this Mac. Xcode ≤ 26: Simulator.app (process `Simulator`), one
 * window per booted device, which warden tiles or closes. Xcode 27 removed it for Device Hub
 * (`Xcode.app/Contents/Applications/DeviceHub.app`, `com.apple.dt.Devices`, process `DeviceHub`),
 * which also has a window per device (System Events sees them; verified on Xcode 27.1). Headless
 * never closes those (Device Hub opens none by itself); `warden dev` closes the one it opened once
 * its sim is shut down (`SimWindowArranger.close`).
 */
export type SimViewer = { kind: "simulator" } | { kind: "device-hub" } | { kind: "none" };

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

/** Narrowing guards shared by the window-list and detach-row parsers. */
class JsonGuards {
	isNum(v: unknown): v is number {
		return typeof v === "number" && Number.isFinite(v);
	}

	isRecord(v: unknown): v is Record<string, unknown> {
		return typeof v === "object" && v !== null;
	}
}

const jsonGuards = new JsonGuards();

/** Pure geometry for tiling Simulator windows. */
export class SimWindowLayout {
	/** `warden-iphone-17-1 – iOS 26.5` → `warden-iphone-17-1`. */
	deviceName(title: string): string {
		return title.split(" – ")[0] ?? title;
	}

	/**
	 * Lay warden sims out in natural name order (`-2` before `-10`), left to right then top to bottom.
	 * Simulator windows can't be resized, so a row too wide for the screen overlaps evenly — each
	 * window covers only the right edge of the one before, keeping every title bar readable. Rows wrap
	 * only while they still fit vertically. The result is in raise order (later windows on top).
	 */
	layout(windows: readonly SimWindow[], screen: ScreenArea): WindowMove[] {
		const sims = windows
			.filter((w) => w.title.startsWith(WARDEN_PREFIX))
			.sort((a, b) => naturalOrder.compare(this.deviceName(a.title), this.deviceName(b.title)));
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
			moves.push(...this.layoutRow(row, screen, y));
		}
		return moves;
	}

	private layoutRow(row: readonly SimWindow[], screen: ScreenArea, y: number): WindowMove[] {
		const fullWidth = row.reduce((sum, w) => sum + w.width, 0) + GAP * (row.length - 1);
		const overlap = fullWidth > screen.width && row.length > 1 ? (fullWidth - screen.width) / (row.length - 1) : 0;
		let x = screen.x;
		const moves: WindowMove[] = [];
		for (const w of row) {
			moves.push({ title: w.title, x: Math.round(x), y });
			x += w.width + GAP - overlap;
		}
		return moves;
	}
}

export const simWindowLayout = new SimWindowLayout();

/** The JXA sources, their output parser and the `osascript` runner behind every window operation. */
export class SimWindowScripts {
	/** JXA: the viewer's device windows + the menu-bar screen's visible frame, flipped to top-left origin. */
	read(viewer: WindowViewer): string {
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
	move(viewer: WindowViewer): string {
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
	 * JXA: close the viewer's device windows of the named devices (argv[0] = name[] JSON; a window is
	 * `<name> – <runtime>`) with their close button. For a device that is already shut down: nothing
	 * else happens to it, and the viewer stays up. Device Hub's management window is never one of them.
	 */
	closeByName(viewer: WindowViewer): string {
		return `function run(argv) {
	const procs = Application("System Events").processes.whose({ name: "${PROCESS_NAME[viewer]}" });
	if (procs.length === 0) return "";
	const names = JSON.parse(argv[0]);
	const windows = procs[0].windows().filter((w) => ${KEEP_WINDOW[viewer]});
	for (const w of windows) {
		const title = String(w.name() || "");
		if (!names.some((name) => title === name || title.startsWith(name + " – "))) continue;
		const close = w.buttons.whose({ subrole: "AXCloseButton" });
		if (close.length > 0) close[0].click();
	}
	return "";
}`;
	}

	/** The close-by-title script for Simulator.app (headless hide). */
	closeByTitle(): string {
		return CLOSE_SCRIPT;
	}

	parseRead(stdout: string): Result<{ screen: ScreenArea; windows: SimWindow[] }> {
		let data: unknown;
		try {
			data = JSON.parse(stdout);
		} catch {
			return resultFactory.err(`couldn't parse Simulator window list: ${stdout.trim().slice(0, 80)}`);
		}
		if (!jsonGuards.isRecord(data) || !jsonGuards.isRecord(data.screen) || !Array.isArray(data.windows)) {
			return resultFactory.err("unexpected Simulator window list shape");
		}
		const { x, y, width, height } = data.screen;
		if (!jsonGuards.isNum(x) || !jsonGuards.isNum(y) || !jsonGuards.isNum(width) || !jsonGuards.isNum(height)) {
			return resultFactory.err("unexpected screen frame");
		}
		const windows: SimWindow[] = [];
		for (const w of data.windows) {
			if (
				jsonGuards.isRecord(w) &&
				typeof w.title === "string" &&
				jsonGuards.isNum(w.width) &&
				jsonGuards.isNum(w.height)
			) {
				windows.push({ title: w.title, width: w.width, height: w.height });
			}
		}
		return resultFactory.ok({ screen: { x, y, width, height }, windows });
	}

	run(exec: Exec, script: string, ...args: string[]) {
		return exec(["osascript", "-l", "JavaScript", "-e", script, ...args], { timeoutMs: 15_000 });
	}

	scriptError(cmd: string, result: { exitCode: number; stdout: string; stderr: string }): string {
		const hint = /assistive|-1719|-25211|not allowed/i.test(result.stderr)
			? " — allow your terminal in System Settings → Privacy & Security → Accessibility"
			: "";
		return `${execErrors.format(["osascript", cmd], result)}${hint}`;
	}
}

export const simWindowScripts = new SimWindowScripts();

const NOT_RUNNING = 1;

/** What `SimWindowArranger.arrange` did, and which viewer it found. */
export type Arranged = { arranged: string[]; viewer: SimViewer["kind"] };

export type AutoArrangeDeps = {
	exec: Exec;
	env: Record<string, string | undefined>;
	os?: NodeJS.Platform;
	sleep?: (ms: number) => Promise<void>;
};

/** What the arranger needs; `env` only matters to the arrange / open paths. */
export type SimWindowArrangerDeps = Pick<AutoArrangeDeps, "exec" | "os" | "sleep"> & {
	env?: Record<string, string | undefined>;
};

const SETTLE_TRIES = 6;
const SETTLE_MS = 500;
/** a deep link Device Hub dropped (seen once, right after it was relaunched) is asked for again at this attempt */
const REOPEN_AT = 3;

/** Which viewer `SimWindowArranger.reveal` brought to the front. */
export type Revealed = { viewer: "device-hub" | "simulator" };

const OPEN_TIMEOUT_MS = 10_000;

/** Tiles, opens, reveals and closes simulator viewer windows (macOS, via System Events). */
export class SimWindowArranger {
	constructor(private readonly deps: SimWindowArrangerDeps) {}

	/**
	 * Which viewer is running, by process rather than by Xcode version: the windows belong to whichever
	 * app is up, and a Mac can have Xcode 26 and 27 side by side. `pgrep -xq` (~10 ms) answers before an
	 * osascript JXA start (35 ms and up) is spent asking an app that is not there — the usual case for a
	 * headless run. Only a plain "no match" (exit 1) says no; any other outcome of the Simulator probe
	 * (pgrep missing or failing) means "Simulator.app, ask osascript", as before Device Hub existed.
	 */
	async detectViewer(): Promise<SimViewer> {
		const { exec } = this.deps;
		if ((await exec(["pgrep", "-xq", "Simulator"])).exitCode !== NOT_RUNNING) return { kind: "simulator" };
		if ((await exec(["pgrep", "-xq", "DeviceHub"])).exitCode === 0) return { kind: "device-hub" };
		return { kind: "none" };
	}

	/**
	 * Tile open Simulator.app / Device Hub windows of warden sims in name order (macOS, via System
	 * Events). Never launches a viewer: no windows → nothing to do. Returns the device names it arranged.
	 */
	async arrange(): AsyncResult<Arranged> {
		const { exec } = this.deps;
		const { kind: viewer } = await this.detectViewer();
		if (viewer === "none") return resultFactory.ok({ arranged: [], viewer });
		const read = await simWindowScripts.run(exec, simWindowScripts.read(viewer));
		if (read.exitCode !== 0) return resultFactory.err(simWindowScripts.scriptError("(read windows)", read));
		const parsed = simWindowScripts.parseRead(read.stdout);
		if (!parsed.success) return parsed;
		const moves = simWindowLayout.layout(parsed.data.windows, parsed.data.screen);
		if (moves.length === 0) return resultFactory.ok({ arranged: [], viewer });
		const moved = await simWindowScripts.run(exec, simWindowScripts.move(viewer), JSON.stringify(moves));
		if (moved.exitCode !== 0) return resultFactory.err(simWindowScripts.scriptError("(move windows)", moved));
		return resultFactory.ok({ arranged: moves.map((m) => simWindowLayout.deviceName(m.title)), viewer });
	}

	/**
	 * After a claim: best-effort arrange (macOS, unless `WARDEN_ARRANGE=0`). A freshly booted sim's
	 * window can lag the boot, so while the viewer is showing windows but not yet every device in
	 * `claimed`, retry briefly. `claimed` is who to wait for: the sims this claim booted — a sim that
	 * was already running keeps whatever window (or none, when it booted headless) it had, so waiting
	 * for it would only burn the retries. `opened` (what `openDeviceHubWindows` returned) are windows
	 * that were just asked for, so an empty list is also waited out for them, and any still missing at
	 * attempt 3 are handed to `reopen` once. Errors are swallowed —
	 * window layout never fails a claim.
	 */
	async autoArrange(
		claimed: readonly string[],
		opened: readonly string[] = [],
		reopen?: (missing: readonly string[]) => Promise<unknown>
	): Promise<void> {
		if (this.arrangeDisabled()) return;
		const sleep = this.deps.sleep ?? ((ms: number) => Bun.sleep(ms));
		for (let attempt = 1; ; attempt++) {
			const result = await this.arrange();
			if (!result.success) return;
			const { arranged } = result.data;
			if (arranged.length === 0 && opened.length === 0) return;
			if (claimed.every((name) => arranged.includes(name)) || attempt >= SETTLE_TRIES) return;
			if (attempt === REOPEN_AT && reopen) await this.reopenMissing(reopen, opened, arranged);
			await sleep(SETTLE_MS);
		}
	}

	/**
	 * Xcode 27, non-headless: Device Hub opens no window when a sim boots (verified on 27.1), unlike
	 * Simulator.app, so ask for one per sim — `open -g` keeps the user's app in front. Only while Device
	 * Hub is already running: the URL launches it otherwise, and warden never launches a viewer (Xcode 26
	 * parity). `sims` should be the ones this claim booted; a sim that was already running keeps whatever
	 * window state its user gave it. Returns the names it asked for; never throws or fails a claim.
	 */
	async openDeviceHubWindows(sims: readonly { udid: string; name: string }[]): Promise<string[]> {
		if (this.arrangeDisabled() || sims.length === 0) return [];
		if ((await this.detectViewer()).kind !== "device-hub") return [];
		const opened: string[] = [];
		for (const sim of sims) {
			const out = await this.deps.exec(["open", "-g", this.deviceHubUrl(sim.udid)], { timeoutMs: 10_000 });
			if (out.exitCode === 0) opened.push(sim.name);
		}
		return opened;
	}

	/**
	 * Put leased sims' windows back after something rebooted them (`warden arrange --open <udid…>`, called by
	 * the e2e session after its HID-loss reboot): ask Device Hub for their windows (`openDeviceHubWindows`:
	 * only while it runs), wait for them and tile everything. Sims `simctl` does not know are skipped.
	 * Returns the names it asked for; never throws.
	 */
	async reopen(udids: readonly string[]): Promise<string[]> {
		if (this.arrangeDisabled() || udids.length === 0) return [];
		const list = await this.deps.exec(["xcrun", "simctl", "list", "devices", "-j"], { timeoutMs: IOS_TIMEOUTS.listMs });
		const all = list.exitCode === 0 ? simctlListParser.parseAll(list.stdout) : undefined;
		if (!all?.success) return [];
		const sims = all.data.filter((d) => udids.includes(d.udid)).map((d) => ({ udid: d.udid, name: d.name }));
		const opened = await this.openDeviceHubWindows(sims);
		await this.autoArrange(
			sims.map((s) => s.name),
			opened,
			(missing) => this.openDeviceHubWindows(sims.filter((s) => missing.includes(s.name)))
		);
		return opened;
	}

	/**
	 * Bring one sim's window to the front for a person who wants to watch it (`warden dev`). Unlike a
	 * claim, this launches a viewer when none is running — showing the app is the point. Device Hub
	 * (Xcode 27) is asked through its deep link without `-g`, which opens or focuses the device's
	 * window and launches Device Hub itself when it is down; Simulator.app (Xcode ≤ 26) is opened with
	 * the device current. With no viewer running the deep link is tried first and, when nothing on
	 * the Mac handles `devices://` (no Xcode 27), Simulator.app is launched instead. macOS only.
	 */
	async reveal(udid: string): AsyncResult<Revealed> {
		const { exec } = this.deps;
		if ((this.deps.os ?? process.platform) !== "darwin") {
			return resultFactory.err("showing a simulator window needs macOS");
		}
		const opts = { timeoutMs: OPEN_TIMEOUT_MS };
		const hub = () => exec(["open", this.deviceHubUrl(udid)], opts);
		const simulator = () => exec(["open", "-a", "Simulator", "--args", "-CurrentDeviceUDID", udid], opts);
		const { kind } = await this.detectViewer();
		if (kind === "simulator") {
			const out = await simulator();
			return out.exitCode === 0
				? resultFactory.ok({ viewer: "simulator" })
				: resultFactory.err(`Simulator: ${execErrors.format(["open"], out)}`);
		}
		const viaHub = await hub();
		if (viaHub.exitCode === 0) return resultFactory.ok({ viewer: "device-hub" });
		if (kind === "device-hub") return resultFactory.err(`Device Hub: ${execErrors.format(["open"], viaHub)}`);
		const viaSimulator = await simulator();
		if (viaSimulator.exitCode === 0) return resultFactory.ok({ viewer: "simulator" });
		return resultFactory.err(
			`Device Hub: ${execErrors.format(["open"], viaHub)}; Simulator: ${execErrors.format(["open"], viaSimulator)}`
		);
	}

	/**
	 * After a device was shut down: close its viewer window, so a Device Hub device page (which stays
	 * open, showing "Start") or a dark Simulator.app window is not left behind. Both viewers, by device
	 * name; no viewer running → nothing to do. macOS only. Needs Accessibility access like `arrange`.
	 */
	async close(sims: readonly { udid: string; name: string }[]): AsyncResult<void> {
		if ((this.deps.os ?? process.platform) !== "darwin" || sims.length === 0) return resultFactory.ok(undefined);
		const { kind } = await this.detectViewer();
		if (kind === "none") return resultFactory.ok(undefined);
		const names = sims.map((s) => s.name);
		const closed = await simWindowScripts.run(
			this.deps.exec,
			simWindowScripts.closeByName(kind),
			JSON.stringify(names)
		);
		return closed.exitCode === 0
			? resultFactory.ok(undefined)
			: resultFactory.err(simWindowScripts.scriptError("(close windows)", closed));
	}

	/** Window arranging is macOS only and off with `WARDEN_ARRANGE=0`. */
	private arrangeDisabled(): boolean {
		return (this.deps.os ?? process.platform) !== "darwin" || this.deps.env?.WARDEN_ARRANGE === "0";
	}

	/** Hand the opened windows still absent from `arranged` to `reopen`, once. */
	private async reopenMissing(
		reopen: (missing: readonly string[]) => Promise<unknown>,
		opened: readonly string[],
		arranged: readonly string[]
	): Promise<void> {
		const missing = opened.filter((name) => !arranged.includes(name));
		if (missing.length > 0) await reopen(missing);
	}

	/** Device Hub's deep link: opens (or focuses) that device's own window. */
	private deviceHubUrl(udid: string): string {
		return `devices://device/open?id=${udid}`;
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

/** meta row arbitrating `DetachOnWindowClose` across warden processes */
export const DETACH_PREF_META = "headless.detach_pref";
/** how long a hide waits for another process to finish writing or restoring the setting */
const DETACH_WAIT_POLLS = 200;
const DETACH_POLL_MS = 50;
/**
 * Longer than any step between two heartbeats of a hide holding the setting (`beat`: after the
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

type Acquired = { kind: "first"; inherited?: DetachPref } | { kind: "joined" } | { kind: "wait"; joined: boolean };

/** A held setting: `release` puts it back (when last out), `beat` tells other processes this hide still relies on it. */
type DetachHold = { release: () => Promise<void>; beat: () => void };

/** The cross-process reference count behind `DetachOnWindowClose`, one meta row arbitrated by `store.transaction`. */
class DetachArbiter {
	constructor(private readonly lock: DetachLock) {}

	/**
	 * One step of joining the setting's holders, under `BEGIN IMMEDIATE`. Holders (and a `by`) whose
	 * process is gone, or that are older than `DETACH_ROW_TTL_MS`, are dropped; a recent dead holder's
	 * recorded `before` is offered as `inherited`, so the user's value is still put back after a crash.
	 */
	joinStep(token: string, joined: boolean): Acquired {
		const { store, pid } = this.lock;
		return store.transaction((): Acquired => {
			const row = this.parseRow(store.getMeta(DETACH_PREF_META));
			const save = (next: DetachRow) => store.setMeta(DETACH_PREF_META, JSON.stringify(next));
			const me = { token, pid, at: this.now() };
			const live = (row?.holders ?? []).filter((h) => h.token !== token && this.holderLive(h));
			const step = row && this.joinLive(row, live.length > 0);
			if (row && step) {
				const holds = step.kind === "joined" || (step.kind === "wait" && step.joined);
				if (holds && !joined) save({ ...row, holders: [...live, me] });
				return step;
			}
			// nobody (alive) relies on it: this hide switches it on, inheriting a dead holder's `before`
			save({ phase: "setting", by: token, at: me.at, holders: [...live, me] });
			const inherited = row && this.inheritable(row);
			return inherited !== undefined ? { kind: "first", inherited } : { kind: "first" };
		});
	}

	/** Mark the setting on (the first holder, done writing it). */
	markSet(token: string, before: DetachPref): void {
		const { store, pid } = this.lock;
		store.transaction(() => {
			const row = this.parseRow(store.getMeta(DETACH_PREF_META));
			const at = this.now();
			const holders = row?.holders ?? [{ token, pid, at }];
			store.setMeta(DETACH_PREF_META, JSON.stringify({ phase: "set", before, by: token, at, holders }));
		});
	}

	/** Leave; the last live holder gets the user's value back to restore (and the row turns `restoring`). */
	leaveStep(token: string): DetachPref | undefined {
		const { store } = this.lock;
		return store.transaction(() => {
			const row = this.parseRow(store.getMeta(DETACH_PREF_META));
			// not a holder (gave up waiting before it could join): nothing of this hide's to restore
			if (!row?.holders.some((h) => h.token === token)) return undefined;
			const rest = row.holders.filter((h) => h.token !== token && this.holderLive(h));
			if (rest.length > 0) {
				store.setMeta(DETACH_PREF_META, JSON.stringify({ ...row, holders: rest }));
				return undefined;
			}
			store.setMeta(
				DETACH_PREF_META,
				JSON.stringify({ ...row, phase: "restoring", by: token, at: this.now(), holders: [] })
			);
			return row.before ?? "unset";
		});
	}

	/** A holding hide is still at it: re-stamp its holder `at` (and the row's, when it is `by`). */
	beatStep(token: string): void {
		const { store } = this.lock;
		store.transaction(() => {
			const row = this.parseRow(store.getMeta(DETACH_PREF_META));
			if (!row?.holders.some((h) => h.token === token)) return;
			const at = this.now();
			const holders = row.holders.map((h) => (h.token === token ? { ...h, at } : h));
			const next = row.by === token ? { ...row, at, holders } : { ...row, holders };
			store.setMeta(DETACH_PREF_META, JSON.stringify(next));
		});
	}

	finishRestore(token: string): void {
		const { store } = this.lock;
		store.transaction(() => {
			const row = this.parseRow(store.getMeta(DETACH_PREF_META));
			if (row?.phase === "restoring" && row.by === token) store.deleteMeta(DETACH_PREF_META);
		});
	}

	private parseRow(raw: string | undefined): DetachRow | undefined {
		if (raw === undefined) return undefined;
		try {
			const data: unknown = JSON.parse(raw);
			if (!jsonGuards.isRecord(data) || !Array.isArray(data.holders) || typeof data.by !== "string") return undefined;
			const phase = data.phase;
			if (phase !== "setting" && phase !== "set" && phase !== "restoring") return undefined;
			const holders = data.holders.flatMap((h: unknown): DetachHolder[] =>
				jsonGuards.isRecord(h) && typeof h.token === "string" && jsonGuards.isNum(h.pid)
					? [jsonGuards.isNum(h.at) ? { token: h.token, pid: h.pid, at: h.at } : { token: h.token, pid: h.pid }]
					: []
			);
			const before = data.before;
			const row: DetachRow = { phase, by: data.by, holders };
			if (before === "unset" || before === "on" || before === "off") row.before = before;
			if (jsonGuards.isNum(data.at)) row.at = data.at;
			return row;
		} catch {
			return undefined;
		}
	}

	/** Holder tokens are `<pid>:<uuid>`, so a `by` names its process even once it left the holders. */
	private tokenPid(token: string): number | undefined {
		const pid = Number(token.split(":")[0]);
		return Number.isInteger(pid) && pid > 0 ? pid : undefined;
	}

	private now(): number {
		return (this.lock.now ?? Date.now)();
	}

	/** Was `at` (a row's or holder's timestamp; missing = unknown) within `DETACH_ROW_TTL_MS`? */
	private recent(at: number | undefined): boolean {
		return at !== undefined && this.now() - at <= DETACH_ROW_TTL_MS;
	}

	/** A holder still relying on the setting: its process is alive and it joined recently enough. */
	private holderLive(h: DetachHolder): boolean {
		return this.lock.pidAlive(h.pid) && this.recent(h.at);
	}

	/** A taken-over row's `before`, unless the row was last touched longer ago than `DETACH_ROW_TTL_MS`. */
	private inheritable(row: DetachRow): DetachPref | undefined {
		const touched = Math.max(row.at ?? 0, ...row.holders.map((h) => h.at ?? 0));
		return this.recent(touched) ? row.before : undefined;
	}

	/** What a hide does with a row someone alive is behind; undefined: nobody is, take it over. */
	private joinLive(row: DetachRow, othersHold: boolean): Acquired | undefined {
		const byPid = this.tokenPid(row.by);
		const byAlive = byPid !== undefined && this.lock.pidAlive(byPid) && this.recent(row.at);
		if (row.phase === "restoring" && byAlive) return { kind: "wait", joined: false };
		if (row.phase === "setting" && byAlive) return { kind: "wait", joined: true };
		if (row.phase === "set" && othersHold) return { kind: "joined" };
		return undefined;
	}
}

/** `simctl boot` of a device that is already up exits non-zero with this; it is not a failure. */
const ALREADY_BOOTED = /current state: Booted/;

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
export class SimWindowHider {
	private readonly arranger: SimWindowArranger;

	constructor(private readonly deps: HideDeps) {
		this.arranger = new SimWindowArranger(deps);
	}

	async hide(sims: readonly LeasedSim[]): Promise<HideOutcome> {
		return (await this.start(sims)).settled;
	}

	/** `hide` in two steps (see `HideStart`): the caller can go on with the devices that stayed up once `down` resolves. */
	async start(sims: readonly LeasedSim[]): Promise<HideStart> {
		const idle: HideStart = {
			closed: [],
			down: Promise.resolve([]),
			settled: Promise.resolve({ closed: [], rebooted: [] }),
		};
		if ((this.deps.os ?? process.platform) !== "darwin" || sims.length === 0) return idle;
		const titles = await this.leasedTitles(sims);
		if (!titles || titles.length === 0) return idle;
		const { release, beat } = await this.holdDetachPref();
		let closedOk = false;
		try {
			closedOk = await this.closeTitles(titles);
		} finally {
			if (!closedOk) await release();
		}
		if (!closedOk) return idle;
		beat();
		const closed = titles.map((title) => simWindowLayout.deviceName(title));
		const down = this.shutDownByClose(
			sims.filter((s) => closed.includes(s.name)),
			beat
		);
		const settled = this.settle(sims, closed, down, beat, release);
		return { closed, down, settled };
	}

	private async settle(
		sims: readonly LeasedSim[],
		closed: string[],
		down: Promise<LeasedSim[]>,
		beat: () => void,
		release: () => Promise<void>
	): Promise<HideOutcome> {
		try {
			const { rebooted, failed } = await this.rebootAll(await down, beat);
			if (rebooted.length > 0) {
				const again = await this.leasedTitles(sims.filter((s) => rebooted.includes(s.name)));
				if (again && again.length > 0) await this.closeTitles(again);
			}
			return failed.length > 0 ? { closed, rebooted, failed } : { closed, rebooted };
		} finally {
			await release();
		}
	}

	private async readDetachPref(): Promise<DetachPref> {
		const out = await this.deps.exec(["defaults", "read", ...DETACH_PREF]);
		if (out.exitCode !== 0) return "unset";
		const value = out.stdout.trim();
		if (value === "1") return "on";
		return value === "0" ? "off" : "unset";
	}

	private async restoreDetachPref(before: DetachPref): Promise<void> {
		if (before === "on") return;
		const argv =
			before === "off"
				? ["defaults", "write", ...DETACH_PREF, "-bool", "false"]
				: ["defaults", "delete", ...DETACH_PREF];
		const out = await this.deps.exec(argv);
		if (out.exitCode !== 0) {
			this.deps.warn(`headless: couldn't restore Simulator's close setting: ${execErrors.format(argv, out)}`);
		}
	}

	/** The first holder: read the user's value, switch it on, and record what to put back. */
	private async switchOn(arbiter: DetachArbiter, token: string, inherited: DetachPref | undefined): Promise<void> {
		const read = await this.readDetachPref();
		// a dead holder's value only explains an `on` it left behind; anything else is the user's own
		const before = inherited !== undefined && read === "on" ? inherited : read;
		if (read !== "on") await this.deps.exec(["defaults", "write", ...DETACH_PREF, "-bool", "true"]);
		arbiter.markSet(token, before);
	}

	/**
	 * Switch `DetachOnWindowClose` on for this hide; the returned release puts the user's value back when
	 * this hide is the last one relying on it. With a `detachLock`, every warden process shares one
	 * reference count (meta row `DETACH_PREF_META`, arbitrated by `store.transaction`): the first holder
	 * reads and writes, later ones join, the last one out restores.
	 */
	private async holdDetachPref(): Promise<DetachHold> {
		const lock = this.deps.detachLock;
		if (!lock) {
			const before = await this.readDetachPref();
			if (before !== "on") await this.deps.exec(["defaults", "write", ...DETACH_PREF, "-bool", "true"]);
			return { release: () => this.restoreDetachPref(before), beat: () => {} };
		}
		const arbiter = new DetachArbiter(lock);
		const token = `${lock.pid}:${crypto.randomUUID()}`;
		await this.joinDetach(arbiter, token);
		return {
			release: async () => {
				const before = arbiter.leaveStep(token);
				if (before === undefined) return;
				await this.restoreDetachPref(before);
				arbiter.finishRestore(token);
			},
			beat: () => arbiter.beatStep(token),
		};
	}

	private async joinDetach(arbiter: DetachArbiter, token: string): Promise<void> {
		const sleep = this.deps.sleep ?? ((ms: number) => Bun.sleep(ms));
		let joined = false;
		for (let i = 0; ; i++) {
			const step = arbiter.joinStep(token, joined);
			if (step.kind === "first") {
				await this.switchOn(arbiter, token, step.inherited);
				return;
			}
			if (step.kind === "joined") return;
			joined = step.joined;
			if (i >= DETACH_WAIT_POLLS) {
				this.deps.warn("headless: another warden is still changing Simulator's close setting — closing anyway");
				return;
			}
			await sleep(DETACH_POLL_MS);
		}
	}

	/**
	 * Titles of the open Simulator.app windows that belong to `sims`; undefined after a warned error.
	 * Device Hub (Xcode 27) windows are not closed yet: under Device Hub this returns none.
	 */
	private async leasedTitles(sims: readonly LeasedSim[]): Promise<string[] | undefined> {
		const { exec, warn } = this.deps;
		if ((await this.arranger.detectViewer()).kind !== "simulator") return [];
		const read = await simWindowScripts.run(exec, simWindowScripts.read("simulator"));
		if (read.exitCode !== 0) {
			warn(`headless: ${simWindowScripts.scriptError("(read windows)", read)}`);
			return undefined;
		}
		const parsed = simWindowScripts.parseRead(read.stdout);
		if (!parsed.success) {
			warn(`headless: ${parsed.error}`);
			return undefined;
		}
		const names = new Set(sims.map((s) => s.name));
		return parsed.data.windows.map((w) => w.title).filter((title) => names.has(simWindowLayout.deviceName(title)));
	}

	private async closeTitles(titles: readonly string[]): Promise<boolean> {
		const closed = await simWindowScripts.run(this.deps.exec, simWindowScripts.closeByTitle(), JSON.stringify(titles));
		if (closed.exitCode === 0) return true;
		this.deps.warn(`headless: ${simWindowScripts.scriptError("(close windows)", closed)}`);
		return false;
	}

	/** `simctl list` states by udid; undefined after a warned error. */
	private async simStates(): Promise<Map<string, string> | undefined> {
		const list = await this.deps.exec(["xcrun", "simctl", "list", "devices", "-j"], { timeoutMs: IOS_TIMEOUTS.listMs });
		const all = list.exitCode === 0 ? simctlListParser.parseAll(list.stdout) : undefined;
		if (all?.success) return new Map(all.data.map((d) => [d.udid, d.state]));
		this.deps.warn(
			`headless: couldn't check device states after closing windows: ${all ? all.error : list.stderr.trim()}`
		);
		return undefined;
	}

	/** Which of `sims` are no longer `Booted` after their window closed, once they finished shutting down. */
	private async shutDownByClose(sims: readonly LeasedSim[], beat: () => void): Promise<LeasedSim[]> {
		const sleep = this.deps.sleep ?? ((ms: number) => Bun.sleep(ms));
		await sleep(CLOSE_SETTLE_MS);
		let states = await this.simStates();
		beat();
		// `simctl boot` refuses a device that is still shutting down
		for (let i = 0; states && i < SHUTDOWN_POLLS && sims.some((s) => states?.get(s.udid) === "Shutting Down"); i++) {
			await sleep(SHUTDOWN_POLL_MS);
			states = await this.simStates();
			beat();
		}
		if (!states) return [];
		return sims.filter((s) => states?.get(s.udid) !== "Booted");
	}

	/** Boot one shut-down device again (headless) and probe it; false after a warned `bootstatus` or probe failure. */
	private async rebootOne(sim: LeasedSim, beat: () => void): Promise<boolean> {
		const { exec, warn } = this.deps;
		warn(`headless: closing ${sim.name}'s window shut it down — booting it again without a window`);
		await this.deps.onShutDown?.(sim.udid);
		const bootArgv = ["xcrun", "simctl", "boot", sim.udid];
		const boot = await exec(bootArgv, { timeoutMs: IOS_TIMEOUTS.bootMs });
		beat();
		// not fatal: `bootstatus -b` boots the device itself (one still `Shutting Down`, a transient refusal)
		if (boot.exitCode !== 0 && !ALREADY_BOOTED.test(boot.stderr)) {
			warn(`headless: ${sim.name}: ${execErrors.format(bootArgv, boot)} — waiting for bootstatus to boot it`);
		}
		const statusArgv = ["xcrun", "simctl", "bootstatus", sim.udid, "-b"];
		const ready = await exec(statusArgv, { timeoutMs: BOOT_TIMEOUT_MS });
		if (ready.exitCode !== 0) {
			warn(`headless: ${sim.name}: ${execErrors.format(statusArgv, ready)}`);
			return false;
		}
		const probe = await new IosHealth({ exec, timer: this.deps.timer ?? timers.real }).probeWarm(sim.udid);
		if (!probe.success) {
			warn(`headless: ${sim.name} booted again but is not healthy: ${probe.error.message}`);
			return false;
		}
		return true;
	}

	/** Boot `down` again in parallel; names that came back healthy, and those that did not. */
	private async rebootAll(
		down: readonly LeasedSim[],
		beat: () => void
	): Promise<{ rebooted: string[]; failed: string[] }> {
		const results = await Promise.all(
			down.map(async (sim) => {
				const ok = await this.rebootOne(sim, beat);
				beat();
				return { name: sim.name, ok };
			})
		);
		return {
			rebooted: results.filter((r) => r.ok).map((r) => r.name),
			failed: results.filter((r) => !r.ok).map((r) => r.name),
		};
	}
}
