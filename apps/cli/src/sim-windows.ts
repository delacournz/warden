import { type Exec, execError } from "@delacour/warden-core/exec";
import { parseAllSims } from "@delacour/warden-core/sims/list";
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

/** JXA: Simulator.app's windows + the menu-bar screen's visible frame, flipped to top-left origin. */
const READ_SCRIPT = `ObjC.import("AppKit");
function run() {
	const s = $.NSScreen.screens.objectAtIndex(0);
	const f = s.frame, v = s.visibleFrame;
	const screen = { x: v.origin.x, y: f.size.height - (v.origin.y + v.size.height), width: v.size.width, height: v.size.height };
	const procs = Application("System Events").processes.whose({ name: "Simulator" });
	const windows = procs.length === 0 ? [] : procs[0].windows().map((w) => {
		const size = w.size();
		return { title: w.name() || "", width: size[0], height: size[1] };
	});
	return JSON.stringify({ screen, windows });
}`;

/** JXA: move each window (argv[0] = WindowMove[] JSON) and raise it, in order. */
const MOVE_SCRIPT = `function run(argv) {
	const proc = Application("System Events").processes.byName("Simulator");
	for (const m of JSON.parse(argv[0])) {
		const w = proc.windows.byName(m.title);
		w.position = [m.x, m.y];
		w.actions.byName("AXRaise").perform();
	}
	return "";
}`;

/** JXA: close each named window (argv[0] = title[] JSON) with its close button; a missing one is skipped. */
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
 * Is Simulator.app running? `pgrep -xq` (~10 ms) answers before an osascript JXA start (35 ms and
 * up) is spent asking an app that is not there — the usual case for a headless run. Only a plain
 * "no match" (exit 1) says no; any other outcome (pgrep missing or failing) means "ask osascript".
 */
async function simulatorRunning(exec: Exec): Promise<boolean> {
	const found = await exec(["pgrep", "-xq", "Simulator"]);
	return found.exitCode !== 1;
}

function scriptError(cmd: string, result: { exitCode: number; stdout: string; stderr: string }): string {
	const hint = /assistive|-1719|-25211|not allowed/i.test(result.stderr)
		? " — allow your terminal in System Settings → Privacy & Security → Accessibility"
		: "";
	return `${execError(["osascript", cmd], result)}${hint}`;
}

/**
 * Tile open Simulator.app windows of warden sims in name order (macOS, via System Events). Never
 * launches Simulator.app: no windows → nothing to do. Returns the device names it arranged.
 */
export async function arrangeSimWindows(exec: Exec): AsyncResult<{ arranged: string[] }> {
	if (!(await simulatorRunning(exec))) return ok({ arranged: [] });
	const read = await osascript(exec, READ_SCRIPT);
	if (read.exitCode !== 0) return err(scriptError("(read windows)", read));
	const parsed = parseRead(read.stdout);
	if (!parsed.success) return parsed;
	const moves = layoutWindows(parsed.data.windows, parsed.data.screen);
	if (moves.length === 0) return ok({ arranged: [] });
	const moved = await osascript(exec, MOVE_SCRIPT, JSON.stringify(moves));
	if (moved.exitCode !== 0) return err(scriptError("(move windows)", moved));
	return ok({ arranged: moves.map((m) => deviceName(m.title)) });
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
	os?: NodeJS.Platform;
	sleep?: (ms: number) => Promise<void>;
};

export type HideOutcome = { closed: string[]; rebooted: string[] };

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

/** Titles of the open Simulator.app windows that belong to `sims`; undefined after a warned error. */
async function leasedTitles(deps: HideDeps, sims: readonly LeasedSim[]): Promise<string[] | undefined> {
	if (!(await simulatorRunning(deps.exec))) return [];
	const read = await osascript(deps.exec, READ_SCRIPT);
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
 * never another device's), macOS only. Never launches Simulator.app — not running → nothing to do.
 * The close detaches (Simulator's `DetachOnWindowClose`, restored afterwards), so the device keeps
 * running; one that shut down anyway is booted again without a window (`simctl boot` +
 * `bootstatus -b`) and a window Simulator.app reattached to it is closed once more.
 * Never fails: errors go to `warn`.
 */
export async function hideSimWindows(deps: HideDeps, sims: readonly LeasedSim[]): Promise<HideOutcome> {
	const none: HideOutcome = { closed: [], rebooted: [] };
	if ((deps.os ?? process.platform) !== "darwin" || sims.length === 0) return none;
	const titles = await leasedTitles(deps, sims);
	if (!titles || titles.length === 0) return none;
	const before = await readDetachPref(deps.exec);
	if (before !== "on") await deps.exec(["defaults", "write", ...DETACH_PREF, "-bool", "true"]);
	try {
		if (!(await closeTitles(deps, titles))) return none;
		const closed = titles.map(deviceName);
		const rebooted = await rebootShutDown(
			deps,
			sims.filter((s) => closed.includes(s.name))
		);
		if (rebooted.length > 0) {
			const again = await leasedTitles(
				deps,
				sims.filter((s) => rebooted.includes(s.name))
			);
			if (again && again.length > 0) await closeTitles(deps, again);
		}
		return { closed, rebooted };
	} finally {
		await restoreDetachPref(deps, before);
	}
}

/** `simctl list` states by udid; undefined after a warned error. */
async function simStates(deps: HideDeps): Promise<Map<string, string> | undefined> {
	const list = await deps.exec(["xcrun", "simctl", "list", "devices", "-j"]);
	const all = list.exitCode === 0 ? parseAllSims(list.stdout) : undefined;
	if (all?.success) return new Map(all.data.map((d) => [d.udid, d.state]));
	deps.warn(`headless: couldn't check device states after closing windows: ${all ? all.error : list.stderr.trim()}`);
	return undefined;
}

/** Boot again (headless) any of `sims` that is no longer `Booted` after its window closed, once it finished shutting down. */
async function rebootShutDown(deps: HideDeps, sims: readonly LeasedSim[]): Promise<string[]> {
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	await sleep(CLOSE_SETTLE_MS);
	let states = await simStates(deps);
	// `simctl boot` refuses a device that is still shutting down
	for (let i = 0; states && i < SHUTDOWN_POLLS && sims.some((s) => states?.get(s.udid) === "Shutting Down"); i++) {
		await sleep(SHUTDOWN_POLL_MS);
		states = await simStates(deps);
	}
	if (!states) return [];
	const down = sims.filter((s) => states?.get(s.udid) !== "Booted");
	const rebooted: string[] = [];
	for (const sim of down) {
		deps.warn(`headless: closing ${sim.name}'s window shut it down — booting it again without a window`);
		await deps.exec(["xcrun", "simctl", "boot", sim.udid]);
		const ready = await deps.exec(["xcrun", "simctl", "bootstatus", sim.udid, "-b"], { timeoutMs: BOOT_TIMEOUT_MS });
		if (ready.exitCode === 0) rebooted.push(sim.name);
		else deps.warn(`headless: ${execError(["xcrun", "simctl", "bootstatus", sim.udid, "-b"], ready)}`);
	}
	return rebooted;
}
