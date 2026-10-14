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
 * window can lag the boot, so while Simulator.app is showing windows but not yet every claimed
 * device, retry briefly. Errors are swallowed — window layout never fails a claim.
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

/** a closed window can take a moment to shut its device down (Simulator's "close = shut down" setting) */
const CLOSE_SETTLE_MS = 500;
const BOOT_TIMEOUT_MS = 180_000;

/**
 * Headless: close the Simulator.app windows of the leased devices (matched by `deviceName(title)`,
 * never another device's), macOS only. Never launches Simulator.app — not running → nothing to do.
 * A device the close shut down is booted again without a window (`simctl boot` + `bootstatus -b`).
 * Never fails: errors go to `warn`.
 */
export async function hideSimWindows(deps: HideDeps, sims: readonly LeasedSim[]): Promise<HideOutcome> {
	const none: HideOutcome = { closed: [], rebooted: [] };
	if ((deps.os ?? process.platform) !== "darwin" || sims.length === 0) return none;
	const read = await osascript(deps.exec, READ_SCRIPT);
	if (read.exitCode !== 0) {
		deps.warn(`headless: ${scriptError("(read windows)", read)}`);
		return none;
	}
	const parsed = parseRead(read.stdout);
	if (!parsed.success) {
		deps.warn(`headless: ${parsed.error}`);
		return none;
	}
	const names = new Set(sims.map((s) => s.name));
	const titles = parsed.data.windows.map((w) => w.title).filter((title) => names.has(deviceName(title)));
	if (titles.length === 0) return none;
	const closed = await osascript(deps.exec, CLOSE_SCRIPT, JSON.stringify(titles));
	if (closed.exitCode !== 0) {
		deps.warn(`headless: ${scriptError("(close windows)", closed)}`);
		return none;
	}
	const closedNames = titles.map(deviceName);
	const rebooted = await rebootShutDown(
		deps,
		sims.filter((s) => closedNames.includes(s.name))
	);
	return { closed: closedNames, rebooted };
}

/** Boot again (headless) any of `sims` that is no longer `Booted` after its window closed. */
async function rebootShutDown(deps: HideDeps, sims: readonly LeasedSim[]): Promise<string[]> {
	await (deps.sleep ?? ((ms: number) => Bun.sleep(ms)))(CLOSE_SETTLE_MS);
	const list = await deps.exec(["xcrun", "simctl", "list", "devices", "-j"]);
	const all = list.exitCode === 0 ? parseAllSims(list.stdout) : undefined;
	if (!all?.success) {
		deps.warn(`headless: couldn't check device states after closing windows: ${all ? all.error : list.stderr.trim()}`);
		return [];
	}
	const down = sims.filter((s) => all.data.find((d) => d.udid === s.udid)?.state !== "Booted");
	const rebooted: string[] = [];
	for (const sim of down) {
		deps.warn(
			`headless: closing ${sim.name}'s window shut it down — booting it again without a window (Simulator.app is set to shut devices down when their window closes)`
		);
		// "already booted" / "shutting down" are fine here: bootstatus -b boots it and waits either way
		await deps.exec(["xcrun", "simctl", "boot", sim.udid]);
		const ready = await deps.exec(["xcrun", "simctl", "bootstatus", sim.udid, "-b"], { timeoutMs: BOOT_TIMEOUT_MS });
		if (ready.exitCode === 0) rebooted.push(sim.name);
		else deps.warn(`headless: ${execError(["xcrun", "simctl", "bootstatus", sim.udid, "-b"], ready)}`);
	}
	return rebooted;
}
