import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import { IOS_TIMEOUTS } from "@delacour/warden-core/providers/ios";
import { simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { openStore } from "@delacour/warden-core/store";
import {
	arrangeSimWindows,
	autoArrangeSimWindows,
	DETACH_PREF_META,
	detectSimViewer,
	deviceName,
	hideSimWindows,
	layoutWindows,
	type SimWindow,
	startHideSimWindows,
} from "./sim-windows";

const screen = { x: 0, y: 33, width: 1728, height: 1021 };
const sim = (title: string, width = 456, height = 972): SimWindow => ({ title, width, height });

describe("deviceName", () => {
	test("strips the ` – <runtime>` suffix", () => {
		expect(deviceName("warden-iphone-17-1 – iOS 26.5")).toBe("warden-iphone-17-1");
		expect(deviceName("warden-ipad")).toBe("warden-ipad");
	});
});

describe("layoutWindows", () => {
	test("natural name order, side by side when they fit", () => {
		const plan = layoutWindows([sim("warden-iphone-17-10 – iOS 26.5"), sim("warden-iphone-17-2 – iOS 26.5")], screen);
		expect(plan).toEqual([
			{ title: "warden-iphone-17-2 – iOS 26.5", x: 0, y: 33 },
			{ title: "warden-iphone-17-10 – iOS 26.5", x: 464, y: 33 },
		]);
	});

	test("only warden sims", () => {
		const plan = layoutWindows([sim("iPhone 17 Pro – iOS 26.5"), sim("warden-iphone-17-1 – iOS 26.5")], screen);
		expect(plan.map((p) => p.title)).toEqual(["warden-iphone-17-1 – iOS 26.5"]);
	});

	test("overlaps evenly to fill the screen when the row is too wide; last one ends at the edge", () => {
		const windows = [5, 3, 1, 4, 2].map((n) => sim(`warden-iphone-17-${n} – iOS 26.5`));
		const plan = layoutWindows(windows, screen);
		expect(plan.map((p) => p.title)).toEqual([1, 2, 3, 4, 5].map((n) => `warden-iphone-17-${n} – iOS 26.5`));
		expect(plan.map((p) => p.x)).toEqual([0, 318, 636, 954, 1272]);
		expect(plan.every((p) => p.y === 33)).toBe(true);
	});

	test("wraps to more rows when the screen is tall enough", () => {
		const tall = { x: 0, y: 25, width: 1000, height: 2000 };
		const plan = layoutWindows(
			[1, 2, 3, 4].map((n) => sim(`warden-iphone-17-${n} – iOS 26.5`)),
			tall
		);
		expect(plan.map((p) => [p.x, p.y])).toEqual([
			[0, 25],
			[464, 25],
			[0, 1005],
			[464, 1005],
		]);
	});

	test("respects the screen origin", () => {
		const plan = layoutWindows([sim("warden-a")], { x: 100, y: 50, width: 800, height: 1000 });
		expect(plan).toEqual([{ title: "warden-a", x: 100, y: 50 }]);
	});

	test("nothing to arrange", () => {
		expect(layoutWindows([], screen)).toEqual([]);
	});
});

/** the `osascript` calls of a fake's log (the `pgrep` guard before them is not one) */
const osascripts = (calls: string[][]) => calls.filter((c) => c[0] === "osascript");

/** both viewer probes, Simulator.app (Xcode ≤ 26) first */
const NO_VIEWER = [
	["pgrep", "-xq", "Simulator"],
	["pgrep", "-xq", "DeviceHub"],
];

/** `pgrep -xq` finding only `running`'s process; anything else succeeds empty. */
function viewerExec(running: "simulator" | "device-hub" | "none", calls: string[][] = []): Exec {
	const proc = { simulator: "Simulator", "device-hub": "DeviceHub", none: "" }[running];
	return async (cmd) => {
		calls.push([...cmd]);
		if (cmd[0] === "pgrep") return { exitCode: cmd[2] === proc ? 0 : 1, stdout: "", stderr: "" };
		return { exitCode: 0, stdout: "", stderr: "" };
	};
}

describe("detectSimViewer", () => {
	test("Simulator.app (Xcode ≤ 26) running → simulator, one pgrep", async () => {
		const calls: string[][] = [];
		expect(await detectSimViewer(viewerExec("simulator", calls))).toEqual({ kind: "simulator" });
		expect(calls).toEqual([["pgrep", "-xq", "Simulator"]]);
	});

	test("Device Hub (Xcode 27) running → device-hub", async () => {
		const calls: string[][] = [];
		expect(await detectSimViewer(viewerExec("device-hub", calls))).toEqual({ kind: "device-hub" });
		expect(calls).toEqual(NO_VIEWER);
	});

	test("neither running → none", async () => {
		expect(await detectSimViewer(viewerExec("none"))).toEqual({ kind: "none" });
	});

	test("pgrep broken → unknown, assume Simulator.app so osascript still looks", async () => {
		const exec: Exec = async () => ({ exitCode: 127, stdout: "", stderr: "" });
		expect(await detectSimViewer(exec)).toEqual({ kind: "simulator" });
	});
});

describe("arrangeSimWindows", () => {
	const scripted = (read: string, calls: string[][]): Exec => {
		return async (cmd) => {
			calls.push([...cmd]);
			const script = cmd[4] ?? "";
			if (script.includes("NSScreen")) return { exitCode: 0, stdout: read, stderr: "" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};
	};

	test("reads windows + screen, then moves them in order", async () => {
		const calls: string[][] = [];
		const read = JSON.stringify({
			screen,
			windows: [sim("warden-iphone-17-2 – iOS 26.5"), sim("warden-iphone-17-1 – iOS 26.5")],
		});
		const result = await arrangeSimWindows(scripted(read, calls));
		expect(result).toEqual({
			success: true,
			data: { arranged: ["warden-iphone-17-1", "warden-iphone-17-2"], viewer: "simulator" },
		});
		const moves = osascripts(calls);
		expect(moves).toHaveLength(2);
		expect(moves[1]?.slice(0, 4)).toEqual(["osascript", "-l", "JavaScript", "-e"]);
		expect(JSON.parse(moves[1]?.[5] ?? "")).toEqual([
			{ title: "warden-iphone-17-1 – iOS 26.5", x: 0, y: 33 },
			{ title: "warden-iphone-17-2 – iOS 26.5", x: 464, y: 33 },
		]);
	});

	test("no warden windows → no move call", async () => {
		const calls: string[][] = [];
		const result = await arrangeSimWindows(scripted(JSON.stringify({ screen, windows: [] }), calls));
		expect(result).toEqual({ success: true, data: { arranged: [], viewer: "simulator" } });
		expect(osascripts(calls)).toHaveLength(1);
	});

	test("no viewer running (`pgrep -xq` finds neither) → nothing to arrange, osascript never started", async () => {
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			return { exitCode: cmd[0] === "pgrep" ? 1 : 0, stdout: "", stderr: "" };
		};
		expect(await arrangeSimWindows(exec)).toEqual({ success: true, data: { arranged: [], viewer: "none" } });
		expect(calls).toEqual(NO_VIEWER);
	});

	test("Xcode 27 Device Hub → reads and moves the DeviceHub process's per-device windows only", async () => {
		const calls: string[][] = [];
		const inner = viewerExec("device-hub", calls);
		const read = JSON.stringify({
			screen,
			windows: [sim("warden-iphone-17-2 – iOS 27.1"), sim("warden-iphone-17-1 – iOS 27.1")],
		});
		const exec: Exec = async (cmd) => {
			if (cmd[0] === "osascript" && (cmd[4] ?? "").includes("NSScreen")) {
				calls.push([...cmd]);
				return { exitCode: 0, stdout: read, stderr: "" };
			}
			return inner(cmd);
		};
		const result = await arrangeSimWindows(exec);
		expect(result).toEqual({
			success: true,
			data: { arranged: ["warden-iphone-17-1", "warden-iphone-17-2"], viewer: "device-hub" },
		});
		const [readCall, moveCall] = osascripts(calls);
		expect(readCall?.[4]).toContain('name: "DeviceHub"');
		expect(moveCall?.[4]).toContain('byName("DeviceHub")');
		expect(JSON.parse(moveCall?.[5] ?? "[]").map((m: { title: string }) => m.title)).toEqual([
			"warden-iphone-17-1 – iOS 27.1",
			"warden-iphone-17-2 – iOS 27.1",
		]);
	});

	test("Device Hub scripts keep only deviceWindow-* windows (its management window carries a device title); Simulator's do not filter", async () => {
		const scripts: Record<string, string[]> = { "device-hub": [], simulator: [] };
		for (const viewer of ["device-hub", "simulator"] as const) {
			const inner = viewerExec(viewer);
			const exec: Exec = async (cmd) => {
				if (cmd[0] === "osascript") {
					scripts[viewer]?.push(cmd[4] ?? "");
					return {
						exitCode: 0,
						stdout: JSON.stringify({ screen, windows: [sim("warden-iphone-17-1 – iOS 26.5")] }),
						stderr: "",
					};
				}
				return inner(cmd);
			};
			await arrangeSimWindows(exec);
		}
		for (const script of scripts["device-hub"] ?? []) expect(script).toContain("deviceWindow-");
		for (const script of scripts.simulator ?? []) {
			expect(script).not.toContain("deviceWindow-");
			expect(script).toContain('"Simulator"');
		}
	});

	test.each([
		["pgrep missing (127)", 127],
		["pgrep failing (2)", 2],
	])("%s → unknown, so osascript still looks", async (_name, exitCode) => {
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			if (cmd[0] === "pgrep") return { exitCode, stdout: "", stderr: "" };
			return { exitCode: 0, stdout: JSON.stringify({ screen, windows: [] }), stderr: "" };
		};
		expect(await arrangeSimWindows(exec)).toEqual({ success: true, data: { arranged: [], viewer: "simulator" } });
		expect(osascripts(calls)).toHaveLength(1);
	});

	test("osascript failure → error mentioning Accessibility", async () => {
		const exec: Exec = async (cmd) =>
			cmd[0] === "pgrep"
				? { exitCode: 0, stdout: "", stderr: "" }
				: { exitCode: 1, stdout: "", stderr: "not allowed assistive access. (-1719)" };
		const result = await arrangeSimWindows(exec);
		expect(result.success).toBe(false);
		expect(!result.success && result.error).toContain("Accessibility");
	});

	test("garbage read output → error", async () => {
		const result = await arrangeSimWindows(scripted("nope", []));
		expect(result.success).toBe(false);
	});
});

describe("autoArrangeSimWindows", () => {
	const reads = (...lists: string[][]) => {
		const calls: string[][] = [];
		let i = 0;
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			if (!(cmd[4] ?? "").includes("NSScreen")) return { exitCode: 0, stdout: "", stderr: "" };
			const names = lists[Math.min(i++, lists.length - 1)] ?? [];
			return {
				exitCode: 0,
				stdout: JSON.stringify({ screen, windows: names.map((n) => sim(`${n} – iOS 26.5`)) }),
				stderr: "",
			};
		};
		return { exec, calls, reads: () => i };
	};
	const sleep = async () => {};

	test("retries until the claimed sim's window shows up", async () => {
		const fake = reads(["warden-iphone-17-1"], ["warden-iphone-17-1", "warden-iphone-17-2"]);
		await autoArrangeSimWindows({ exec: fake.exec, env: {}, os: "darwin", sleep }, ["warden-iphone-17-2"]);
		expect(fake.reads()).toBe(2);
	});

	test("Simulator.app not showing anything → one read, no wait", async () => {
		const fake = reads([]);
		await autoArrangeSimWindows({ exec: fake.exec, env: {}, os: "darwin", sleep }, ["warden-iphone-17-2"]);
		expect(osascripts(fake.calls)).toHaveLength(1);
	});

	test("no viewer running → the two pgreps, no osascript, no wait", async () => {
		const waits: number[] = [];
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			return { exitCode: cmd[0] === "pgrep" ? 1 : 0, stdout: "", stderr: "" };
		};
		await autoArrangeSimWindows({ exec, env: {}, os: "darwin", sleep: async (ms) => void waits.push(ms) }, ["a"]);
		expect(calls).toEqual(NO_VIEWER);
		expect(waits).toEqual([]);
	});

	test("no device to wait for (all reused) → arranged once, never waits for a window that cannot appear", async () => {
		const fake = reads(["warden-iphone-17-1"]);
		await autoArrangeSimWindows({ exec: fake.exec, env: {}, os: "darwin", sleep }, []);
		expect(fake.reads()).toBe(1);
	});

	test("gives up after a few tries", async () => {
		const fake = reads(["warden-iphone-17-1"]);
		await autoArrangeSimWindows({ exec: fake.exec, env: {}, os: "darwin", sleep }, ["warden-iphone-17-9"]);
		expect(fake.reads()).toBe(6);
	});

	test("off with WARDEN_ARRANGE=0 or off macOS", async () => {
		const fake = reads(["warden-iphone-17-1"]);
		await autoArrangeSimWindows({ exec: fake.exec, env: { WARDEN_ARRANGE: "0" }, os: "darwin", sleep }, []);
		await autoArrangeSimWindows({ exec: fake.exec, env: {}, os: "linux", sleep }, []);
		expect(fake.calls).toHaveLength(0);
	});
});

type State = "Booted" | "Shutdown" | "Shutting Down";

/** Simulator.app's `DetachOnWindowClose` (`defaults` value; undefined = unset), shared by fakes that model one Mac. */
type PrefBox = { value: "0" | "1" | undefined; atClose: Array<"0" | "1" | undefined> };

type FakeOptions = {
	pref?: PrefBox;
	/** how long a window close takes */
	closeMs?: number;
	/** the close script fails (osascript exit 1) */
	closeFails?: boolean;
	onCall?: (cmd: readonly string[]) => void;
	/** false: `launchctl list` shows no SpringBoard (the post-reboot probe fails) */
	springboard?: boolean;
	boot?: (udid: string) => Promise<ExecResult>;
	bootstatus?: (udid: string) => Promise<ExecResult>;
};

const done = (stdout = "", exitCode = 0, stderr = "") => ({ exitCode, stdout, stderr });

/** `afterClose[udid]` on the `n`-th `simctl list` call (1-based; the last state repeats). */
function stateAt(afterClose: Record<string, State | State[]>, udid: string, n: number): State {
	const states = afterClose[udid] ?? "Booted";
	return typeof states === "string" ? states : (states[Math.min(n - 1, states.length - 1)] ?? "Booted");
}

/**
 * Simulator.app showing `titles` (undefined = not running). `afterClose`: each device's state per
 * `simctl list` call once windows close (the last one repeats). `detach`: the user's
 * `DetachOnWindowClose` (`defaults read` output; undefined = unset).
 */
function fakeSimulator(
	leased: ReadonlyArray<{ udid: string; name: string }>,
	titles: string[] | undefined,
	afterClose: Record<string, State | State[]>,
	detach: "0" | "1" | undefined,
	opts: FakeOptions = {}
) {
	const calls: string[][] = [];
	const warnings: string[] = [];
	let lists = 0;
	const pref: PrefBox = opts.pref ?? { value: detach, atClose: [] };
	const windows = () => JSON.stringify({ screen, windows: (titles ?? []).map((t) => sim(t)) });
	const list = () => {
		lists++;
		const sims = leased.map((d) => ({ udid: d.udid, name: d.name, state: stateAt(afterClose, d.udid, lists) }));
		return done(simctlDevicesJson({ "iOS-26-5": sims }));
	};
	const readPref = () => (pref.value === undefined ? done("", 1, "does not exist") : done(`${pref.value}\n`));
	const osascript = async (script: string) => {
		if (!script.includes("AXCloseButton")) return done(script.includes("NSScreen") ? windows() : "");
		if (opts.closeMs !== undefined) await Bun.sleep(opts.closeMs);
		if (opts.closeFails) return done("", 1, "close-boom");
		// the moment the window actually closes: Simulator.app reads the setting now
		pref.atClose.push(pref.value);
		return done();
	};
	const defaults = (cmd: readonly string[]) => {
		if (cmd[1] === "read") return readPref();
		if (cmd[1] === "write") pref.value = cmd.at(-1) === "true" ? "1" : "0";
		if (cmd[1] === "delete") pref.value = undefined;
		return done();
	};
	const launchctlList = opts.springboard === false ? "-\t0\tcom.apple.other\n" : "42\t0\tcom.apple.SpringBoard\n";
	const boot = opts.boot ?? (async () => done());
	const bootstatus = opts.bootstatus ?? (async () => done());
	const simctl = async (cmd: readonly string[]) => {
		const udid = cmd[3] ?? "";
		if (cmd[2] === "spawn") return done(launchctlList);
		if (cmd[2] === "boot") return boot(udid);
		if (cmd[2] === "bootstatus") return bootstatus(udid);
		return cmd.join(" ") === "xcrun simctl list devices -j" ? list() : done();
	};
	const exec: Exec = async (cmd) => {
		calls.push([...cmd]);
		opts.onCall?.(cmd);
		if (cmd[0] === "pgrep") return done("", titles === undefined ? 1 : 0);
		if (cmd[0] === "osascript") return osascript(cmd[4] ?? "");
		if (cmd[0] === "defaults") return defaults(cmd);
		return cmd[0] === "xcrun" ? simctl(cmd) : done();
	};
	const deps = { exec, os: "darwin" as const, sleep: async () => {}, warn: (line: string) => warnings.push(line) };
	return { deps, calls, warnings };
}

describe("hideSimWindows", () => {
	const leased = [
		{ udid: "U1", name: "warden-iphone-17-1" },
		{ udid: "U2", name: "warden-iphone-17-2" },
	];
	const fake = (titles: string[] | undefined, afterClose: Record<string, State | State[]> = {}, detach?: "0" | "1") =>
		fakeSimulator(leased, titles, afterClose, detach);
	const defaultsCalls = (calls: string[][]) => calls.filter((c) => c[0] === "defaults").map((c) => c.join(" "));
	const PREF = "com.apple.iphonesimulator DetachOnWindowClose";
	const closeCalls = (calls: string[][]) =>
		calls.filter((c) => c[0] === "osascript" && (c[4] ?? "").includes("AXCloseButton"));

	test("closes only the windows of leased devices", async () => {
		const f = fake(["warden-iphone-17-1 – iOS 26.5", "warden-iphone-17-3 – iOS 26.5", "iPhone 17 Pro – iOS 26.5"]);
		const out = await hideSimWindows(f.deps, leased);
		expect(out).toEqual({ closed: ["warden-iphone-17-1"], rebooted: [] });
		const close = closeCalls(f.calls);
		expect(close).toHaveLength(1);
		expect(JSON.parse(close[0]?.[5] ?? "")).toEqual(["warden-iphone-17-1 – iOS 26.5"]);
		expect(f.warnings).toEqual([]);
	});

	test("no viewer running → no close, never launched, not even an osascript (the two `pgrep -xq` only)", async () => {
		const f = fake(undefined);
		expect(await hideSimWindows(f.deps, leased)).toEqual({ closed: [], rebooted: [] });
		expect(f.calls).toEqual(NO_VIEWER);
		expect(closeCalls(f.calls)).toHaveLength(0);
		expect(f.calls.some((c) => c.join(" ").includes("open -a"))).toBe(false);
	});

	test("Xcode 27 Device Hub → its windows are never closed, no prefs written, no warning", async () => {
		const calls: string[][] = [];
		const warnings: string[] = [];
		const deps = {
			exec: viewerExec("device-hub", calls),
			os: "darwin" as const,
			sleep: async () => {},
			warn: (line: string) => warnings.push(line),
		};
		const start = await startHideSimWindows(deps, leased);
		expect(start.closed).toEqual([]);
		expect(await start.settled).toEqual({ closed: [], rebooted: [] });
		expect(calls).toEqual(NO_VIEWER);
		expect(warnings).toEqual([]);
	});

	test("a device the close shut down is booted again headless, with a warning", async () => {
		const f = fake(["warden-iphone-17-1 – iOS 26.5", "warden-iphone-17-2 – iOS 26.5"], { U2: "Shutdown" });
		const out = await hideSimWindows(f.deps, leased);
		expect(out).toEqual({ closed: ["warden-iphone-17-1", "warden-iphone-17-2"], rebooted: ["warden-iphone-17-2"] });
		const simctl = f.calls.filter((c) => c[0] === "xcrun").map((c) => c.join(" "));
		expect(simctl).toContain("xcrun simctl boot U2");
		expect(simctl).toContain("xcrun simctl bootstatus U2 -b");
		expect(simctl.some((c) => c.includes("U1") && c.includes("boot"))).toBe(false);
		expect(f.warnings.join("\n")).toContain("warden-iphone-17-2");
	});

	test("a device the close shut down is reported to onShutDown before it is booted again; devices that stayed up are not", async () => {
		const f = fake(["warden-iphone-17-1 – iOS 26.5", "warden-iphone-17-2 – iOS 26.5"], { U2: "Shutdown" });
		const events: string[] = [];
		const exec: typeof f.deps.exec = async (cmd) => {
			if (cmd.join(" ").startsWith("xcrun simctl boot ")) events.push(`boot ${cmd[3]}`);
			return f.deps.exec(cmd);
		};
		await hideSimWindows(
			{
				...f.deps,
				exec,
				onShutDown: async (udid) => {
					events.push(`shut down ${udid}`);
				},
			},
			leased
		);
		expect(events).toEqual(["shut down U2", "boot U2"]);
	});

	test("closes with DetachOnWindowClose on (device keeps running), then deletes the unset preference again", async () => {
		const f = fake(["warden-iphone-17-1 – iOS 26.5"]);
		await hideSimWindows(f.deps, leased);
		expect(defaultsCalls(f.calls)).toEqual([
			`defaults read ${PREF}`,
			`defaults write ${PREF} -bool true`,
			`defaults delete ${PREF}`,
		]);
		const close = f.calls.findIndex((c) => (c[4] ?? "").includes("AXCloseButton"));
		const write = f.calls.findIndex((c) => c.join(" ").includes("-bool true"));
		const restore = f.calls.findIndex((c) => c[1] === "delete");
		expect(write).toBeLessThan(close);
		expect(restore).toBeGreaterThan(close);
	});

	test("a user's DetachOnWindowClose = false is put back; true is left alone", async () => {
		const off = fake(["warden-iphone-17-1 – iOS 26.5"], {}, "0");
		await hideSimWindows(off.deps, leased);
		expect(defaultsCalls(off.calls).at(-1)).toBe(`defaults write ${PREF} -bool false`);
		const on = fake(["warden-iphone-17-1 – iOS 26.5"], {}, "1");
		await hideSimWindows(on.deps, leased);
		expect(defaultsCalls(on.calls)).toEqual([`defaults read ${PREF}`]);
	});

	test("nothing to close → the preference is never touched", async () => {
		const f = fake(["iPhone 17 Pro – iOS 26.5"]);
		await hideSimWindows(f.deps, leased);
		expect(defaultsCalls(f.calls)).toEqual([]);
	});

	test("a device still Shutting Down is waited for before it is booted again; its reattached window is closed again", async () => {
		const f = fake(["warden-iphone-17-2 – iOS 26.5"], { U2: ["Shutting Down", "Shutting Down", "Shutdown"] });
		const out = await hideSimWindows(f.deps, leased);
		expect(out.rebooted).toEqual(["warden-iphone-17-2"]);
		const lines = f.calls.map((c) => c.join(" "));
		const lastList = lines.lastIndexOf("xcrun simctl list devices -j");
		expect(lines.indexOf("xcrun simctl boot U2")).toBeGreaterThan(lastList);
		expect(closeCalls(f.calls)).toHaveLength(2);
		expect(defaultsCalls(f.calls).at(-1)).toBe(`defaults delete ${PREF}`);
	});

	test("osascript failure only warns", async () => {
		const exec: Exec = async (cmd) =>
			cmd[0] === "pgrep"
				? { exitCode: 0, stdout: "", stderr: "" }
				: { exitCode: 1, stdout: "", stderr: "not allowed assistive access. (-1719)" };
		const warnings: string[] = [];
		const out = await hideSimWindows(
			{ exec, os: "darwin", sleep: async () => {}, warn: (l) => warnings.push(l) },
			leased
		);
		expect(out).toEqual({ closed: [], rebooted: [] });
		expect(warnings.join("\n")).toContain("Accessibility");
	});

	test("a failed re-boot only warns", async () => {
		const calls: string[][] = [];
		const warnings: string[] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			if (cmd[0] === "osascript" && (cmd[4] ?? "").includes("NSScreen")) {
				return {
					exitCode: 0,
					stdout: JSON.stringify({ screen, windows: [sim("warden-iphone-17-1 – iOS 26.5")] }),
					stderr: "",
				};
			}
			if (cmd.join(" ") === "xcrun simctl list devices -j") {
				return {
					exitCode: 0,
					stdout: simctlDevicesJson({ "iOS-26-5": [{ udid: "U1", name: "warden-iphone-17-1", state: "Shutdown" }] }),
					stderr: "",
				};
			}
			if (cmd[2] === "bootstatus") return { exitCode: 1, stdout: "", stderr: "boom" };
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const out = await hideSimWindows(
			{ exec, os: "darwin", sleep: async () => {}, warn: (l) => warnings.push(l) },
			leased
		);
		expect(out.rebooted).toEqual([]);
		expect(warnings.join("\n")).toContain("boom");
	});

	test("off macOS or nothing leased → no calls", async () => {
		const f = fake(["warden-iphone-17-1 – iOS 26.5"]);
		await hideSimWindows({ ...f.deps, os: "linux" }, leased);
		await hideSimWindows(f.deps, []);
		expect(f.calls).toHaveLength(0);
	});
});

describe("hideSimWindows: reboots", () => {
	const leased = [
		{ udid: "U1", name: "warden-iphone-17-1" },
		{ udid: "U2", name: "warden-iphone-17-2" },
	];
	const both = ["warden-iphone-17-1 – iOS 26.5", "warden-iphone-17-2 – iOS 26.5"];

	test("devices the close shut down boot again in parallel, each probed with `launchctl list` after", async () => {
		const events: string[] = [];
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const f = fakeSimulator(leased, both, { U1: "Shutdown", U2: "Shutdown" }, undefined, {
			onCall: (cmd) => {
				if (cmd[2] === "boot" || cmd[2] === "bootstatus" || cmd[2] === "spawn") events.push(`${cmd[2]} ${cmd[3]}`);
			},
			bootstatus: async () => {
				await gate;
				return done();
			},
		});
		const hide = hideSimWindows(f.deps, leased);
		// both boots are under way before either finishes booting
		for (let i = 0; i < 50 && events.filter((e) => e.startsWith("bootstatus")).length < 2; i++) await Bun.sleep(1);
		expect(events.slice(0, 4).sort()).toEqual(["boot U1", "boot U2", "bootstatus U1", "bootstatus U2"]);
		release();
		const out = await hide;
		expect(out.rebooted.sort()).toEqual(["warden-iphone-17-1", "warden-iphone-17-2"]);
		expect(events.filter((e) => e.startsWith("spawn")).sort()).toEqual(["spawn U1", "spawn U2"]);
		const probe = f.calls.find((c) => c[2] === "spawn");
		expect(probe?.slice(4)).toEqual(["launchctl", "list"]);
	});

	test("a failed `simctl boot` is warned about, and `bootstatus -b` still boots the device", async () => {
		const f = fakeSimulator(leased, both, { U1: "Shutdown", U2: "Shutdown" }, undefined, {
			boot: async (udid) => (udid === "U2" ? done("", 1, "Unable to boot: boom-boot") : done()),
		});
		const out = await hideSimWindows(f.deps, leased);
		expect(out.rebooted.sort()).toEqual(["warden-iphone-17-1", "warden-iphone-17-2"]);
		expect(out.failed).toBeUndefined();
		expect(f.warnings.join("\n")).toContain("boom-boot");
		expect(f.calls.some((c) => c[2] === "bootstatus" && c[3] === "U2" && c[4] === "-b")).toBe(true);
	});

	test("a failed `simctl boot` whose `bootstatus -b` fails too is reported failed", async () => {
		const f = fakeSimulator(leased, both, { U1: "Shutdown", U2: "Shutdown" }, undefined, {
			boot: async (udid) => (udid === "U2" ? done("", 1, "Unable to boot: boom-boot") : done()),
			bootstatus: async (udid) => (udid === "U2" ? done("", 1, "boom-status") : done()),
		});
		const out = await hideSimWindows(f.deps, leased);
		expect(out.rebooted).toEqual(["warden-iphone-17-1"]);
		expect(out.failed).toEqual(["warden-iphone-17-2"]);
		const warned = f.warnings.join("\n");
		expect(warned).toContain("boom-boot");
		expect(warned).toContain("boom-status");
	});

	test("`simctl boot` saying the device is already Booted is not a failure", async () => {
		const f = fakeSimulator(leased, both, { U1: "Shutdown" }, undefined, {
			boot: async () => done("", 149, "Unable to boot device in current state: Booted"),
		});
		const out = await hideSimWindows(f.deps, leased);
		expect(out.rebooted).toEqual(["warden-iphone-17-1"]);
		expect(out.failed).toBeUndefined();
	});

	test("a rebooted device that fails the warm probe is warned about and reported failed", async () => {
		const f = fakeSimulator(leased, both, { U1: "Shutdown" }, undefined, { springboard: false });
		const out = await hideSimWindows(f.deps, leased);
		expect(out.rebooted).toEqual([]);
		expect(out.failed).toEqual(["warden-iphone-17-1"]);
		expect(f.warnings.join("\n")).toContain("SpringBoard");
	});
});

describe("startHideSimWindows", () => {
	const leased = [
		{ udid: "U1", name: "warden-iphone-17-1" },
		{ udid: "U2", name: "warden-iphone-17-2" },
	];
	const both = ["warden-iphone-17-1 – iOS 26.5", "warden-iphone-17-2 – iOS 26.5"];

	test("resolves once the windows are closed; `down` names what shut down; `settled` follows the reboot", async () => {
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const f = fakeSimulator(leased, both, { U2: "Shutdown" }, undefined, {
			bootstatus: async () => {
				await gate;
				return done();
			},
		});
		const start = await startHideSimWindows(f.deps, leased);
		expect(start.closed).toEqual(["warden-iphone-17-1", "warden-iphone-17-2"]);
		expect(f.calls.some((c) => c[2] === "boot")).toBe(false);
		expect(await start.down).toEqual([{ udid: "U2", name: "warden-iphone-17-2" }]);
		let settled = false;
		start.settled.then(() => {
			settled = true;
		});
		await Bun.sleep(1);
		expect(settled).toBe(false);
		release();
		expect(await start.settled).toEqual({
			closed: ["warden-iphone-17-1", "warden-iphone-17-2"],
			rebooted: ["warden-iphone-17-2"],
		});
		// the preference is put back only after the reboot (its reattached window closes with it still on)
		expect(f.calls.at(-1)?.join(" ")).toBe("defaults delete com.apple.iphonesimulator DetachOnWindowClose");
	});

	test("nothing shut down → `down` is empty and nothing boots", async () => {
		const f = fakeSimulator(leased, both, {}, undefined);
		const start = await startHideSimWindows(f.deps, leased);
		expect(await start.down).toEqual([]);
		expect(await start.settled).toEqual({ closed: ["warden-iphone-17-1", "warden-iphone-17-2"], rebooted: [] });
		expect(f.calls.some((c) => c[2] === "boot")).toBe(false);
	});

	test("nothing to close → everything already resolved", async () => {
		const f = fakeSimulator(leased, undefined, {}, undefined);
		const start = await startHideSimWindows(f.deps, leased);
		expect(start.closed).toEqual([]);
		expect(await start.down).toEqual([]);
		expect(await start.settled).toEqual({ closed: [], rebooted: [] });
	});
});

describe("hideSimWindows: DetachOnWindowClose across processes", () => {
	let dir = "";
	const dbPath = () => join(dir, "warden.db");
	const setup = () => {
		dir = mkdtempSync(join(tmpdir(), "warden-hide-"));
	};
	afterEach(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
		dir = "";
	});
	const one = [{ udid: "U1", name: "warden-iphone-17-1" }];
	const two = [{ udid: "U2", name: "warden-iphone-17-2" }];
	const tick = (ms: number) => Bun.sleep(Math.min(ms, 1));

	test("two concurrent hides keep the setting on for every close and restore it once, after the last", async () => {
		setup();
		const pref: PrefBox = { value: undefined, atClose: [] };
		const storeA = openStore(dbPath());
		const storeB = openStore(dbPath());
		let startB = () => {};
		const bStarted = new Promise<void>((resolve) => {
			startB = resolve;
		});
		const a = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, {
			pref,
			closeMs: 1,
			onCall: (cmd) => {
				if (cmd[0] === "defaults" && cmd[1] === "write") startB();
			},
		});
		const b = fakeSimulator(two, ["warden-iphone-17-2 – iOS 26.5"], {}, undefined, { pref, closeMs: 40 });
		const lock = (store: typeof storeA) => ({ store, pid: process.pid, pidAlive: () => true });
		const hideA = hideSimWindows({ ...a.deps, sleep: tick, detachLock: lock(storeA) }, one);
		await bStarted;
		const hideB = hideSimWindows({ ...b.deps, sleep: tick, detachLock: lock(storeB) }, two);
		await Promise.all([hideA, hideB]);
		storeA.close();
		storeB.close();
		expect(pref.atClose).toEqual(["1", "1"]);
		expect(pref.value).toBeUndefined();
		const defaults = [...a.calls, ...b.calls].filter((c) => c[0] === "defaults" && c[1] !== "read");
		expect(defaults.map((c) => c[1])).toEqual(["write", "delete"]);
		// the last one out restored it: B, whose close ran longest
		expect(b.calls.some((c) => c[0] === "defaults" && c[1] === "delete")).toBe(true);
	});

	test("a hide arriving while another process restores the setting waits, then reads it afresh", async () => {
		setup();
		const store = openStore(dbPath());
		store.setMeta(
			DETACH_PREF_META,
			JSON.stringify({ phase: "restoring", before: "unset", by: `${process.pid}:other`, at: Date.now(), holders: [] })
		);
		const pref: PrefBox = { value: "1", atClose: [] };
		const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref });
		let waits = 0;
		const sleep = async () => {
			waits++;
			// the other process finishes its restore
			if (waits === 1) {
				pref.value = undefined;
				store.deleteMeta(DETACH_PREF_META);
			}
		};
		await hideSimWindows({ ...f.deps, sleep, detachLock: { store, pid: process.pid, pidAlive: () => true } }, one);
		expect(pref.atClose).toEqual(["1"]);
		expect(pref.value).toBeUndefined();
		const defaults = f.calls.filter((c) => c[0] === "defaults").map((c) => c[1]);
		expect(defaults).toEqual(["read", "write", "delete"]);
		expect(store.getMeta(DETACH_PREF_META)).toBeUndefined();
		store.close();
	});

	test("a holder whose process died is dropped; its recorded setting is still put back", async () => {
		setup();
		const store = openStore(dbPath());
		// a crashed hide left `on` written over the user's `off`
		store.setMeta(
			DETACH_PREF_META,
			JSON.stringify({
				phase: "set",
				before: "off",
				by: "dead",
				at: Date.now(),
				holders: [{ token: "dead", pid: 999_999, at: Date.now() }],
			})
		);
		const pref: PrefBox = { value: "1", atClose: [] };
		const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref });
		await hideSimWindows(
			{ ...f.deps, sleep: tick, detachLock: { store, pid: process.pid, pidAlive: (pid) => pid === process.pid } },
			one
		);
		expect(pref.atClose).toEqual(["1"]);
		expect(pref.value).toBe("0");
		expect(store.getMeta(DETACH_PREF_META)).toBeUndefined();
		store.close();
	});

	const other = `${process.pid}:other`;
	const otherHolder = { token: other, pid: process.pid, at: Date.now() };
	const alive = () => true;
	const row = (store: { getMeta: (key: string) => string | undefined }) =>
		JSON.parse(store.getMeta(DETACH_PREF_META) ?? "null");
	const writes = (calls: string[][]) => calls.filter((c) => c[0] === "defaults").map((c) => c[1]);

	test("a hide arriving while another process is switching the setting on joins, waits for `set`, and leaves the restore to it", async () => {
		setup();
		const store = openStore(dbPath());
		store.setMeta(
			DETACH_PREF_META,
			JSON.stringify({ phase: "setting", by: other, at: Date.now(), holders: [otherHolder] })
		);
		const pref: PrefBox = { value: undefined, atClose: [] };
		const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref });
		let waits = 0;
		// only the 50 ms polls for the setting (the close settle sleeps too)
		const sleep = async (ms: number) => {
			if (ms !== 50) return;
			waits++;
			if (waits !== 1) return;
			// this hide already joined the holders while waiting
			expect(row(store).holders.map((h: { token: string }) => h.token)).toHaveLength(2);
			// the other process finishes switching it on (markSet keeps the holders)
			pref.value = "1";
			store.setMeta(DETACH_PREF_META, JSON.stringify({ ...row(store), phase: "set", before: "off" }));
		};
		await hideSimWindows({ ...f.deps, sleep, detachLock: { store, pid: process.pid, pidAlive: alive } }, one);
		expect(waits).toBe(1);
		expect(pref.atClose).toEqual(["1"]);
		// joined, so never read nor wrote; the other process is still a holder, so nothing restored
		expect(writes(f.calls)).toEqual([]);
		expect(pref.value).toBe("1");
		expect(row(store)).toMatchObject({ phase: "set", before: "off", by: other, holders: [otherHolder] });
		store.close();
	});

	test("taking over from a restorer that died writes its recorded value back", async () => {
		setup();
		const store = openStore(dbPath());
		store.setMeta(
			DETACH_PREF_META,
			JSON.stringify({ phase: "restoring", before: "off", by: "999999:dead", at: Date.now(), holders: [] })
		);
		// it died before putting `off` back
		const pref: PrefBox = { value: "1", atClose: [] };
		const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref });
		await hideSimWindows(
			{ ...f.deps, sleep: tick, detachLock: { store, pid: process.pid, pidAlive: (pid) => pid === process.pid } },
			one
		);
		expect(pref.atClose).toEqual(["1"]);
		expect(writes(f.calls)).toEqual(["read", "write"]);
		expect(pref.value).toBe("0");
		expect(store.getMeta(DETACH_PREF_META)).toBeUndefined();
		store.close();
	});

	test("gives up after 200 polls behind a stuck `setting` (joined): warns, closes anyway, then leaves without restoring", async () => {
		setup();
		const store = openStore(dbPath());
		store.setMeta(
			DETACH_PREF_META,
			JSON.stringify({ phase: "setting", by: other, at: Date.now(), holders: [otherHolder] })
		);
		const pref: PrefBox = { value: undefined, atClose: [] };
		const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref });
		let waits = 0;
		const sleep = async (ms: number) => {
			if (ms === 50) waits++;
		};
		const out = await hideSimWindows(
			{ ...f.deps, sleep, detachLock: { store, pid: process.pid, pidAlive: alive } },
			one
		);
		expect(waits).toBe(200);
		expect(out.closed).toEqual(["warden-iphone-17-1"]);
		expect(f.warnings.join("\n")).toContain("closing anyway");
		expect(writes(f.calls)).toEqual([]);
		// it joined while waiting and left again: only the stuck process remains
		expect(row(store)).toMatchObject({ phase: "setting", by: other, holders: [otherHolder] });
		store.close();
	});

	test("gives up after 200 polls behind a stuck `restoring` (not joined): warns, closes anyway, leaves the row alone", async () => {
		setup();
		const store = openStore(dbPath());
		const stuck = { phase: "restoring", before: "unset", by: other, at: Date.now(), holders: [] };
		store.setMeta(DETACH_PREF_META, JSON.stringify(stuck));
		const pref: PrefBox = { value: "1", atClose: [] };
		const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref });
		let waits = 0;
		const sleep = async (ms: number) => {
			if (ms === 50) waits++;
		};
		const out = await hideSimWindows(
			{ ...f.deps, sleep, detachLock: { store, pid: process.pid, pidAlive: alive } },
			one
		);
		expect(waits).toBe(200);
		expect(out.closed).toEqual(["warden-iphone-17-1"]);
		expect(f.warnings.join("\n")).toContain("closing anyway");
		expect(writes(f.calls)).toEqual([]);
		expect(row(store)).toEqual(stuck);
		store.close();
	});

	test("a close that fails after the setting was taken still puts it back and clears the row", async () => {
		setup();
		const store = openStore(dbPath());
		const pref: PrefBox = { value: undefined, atClose: [] };
		const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref, closeFails: true });
		const out = await hideSimWindows(
			{ ...f.deps, sleep: tick, detachLock: { store, pid: process.pid, pidAlive: alive } },
			one
		);
		expect(out).toEqual({ closed: [], rebooted: [] });
		expect(f.warnings.join("\n")).toContain("close-boom");
		expect(writes(f.calls)).toEqual(["read", "write", "delete"]);
		expect(pref.value).toBeUndefined();
		expect(store.getMeta(DETACH_PREF_META)).toBeUndefined();
		store.close();
	});

	describe("stale rows (a crash long ago, a reused pid)", () => {
		const T = 1_800_000_000_000;
		const hour = 3_600_000;
		const lockAt = (store: ReturnType<typeof openStore>, pidAlive: (pid: number) => boolean) => ({
			store,
			pid: process.pid,
			pidAlive,
			now: () => T,
		});

		test("a crashed hide's `before` from long ago is not written back over the user's later `true`", async () => {
			setup();
			const store = openStore(dbPath());
			const old = T - hour;
			store.setMeta(
				DETACH_PREF_META,
				JSON.stringify({
					phase: "set",
					before: "off",
					by: "999999:dead",
					at: old,
					holders: [{ token: "999999:dead", pid: 999_999, at: old }],
				})
			);
			const pref: PrefBox = { value: "1", atClose: [] };
			const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref });
			await hideSimWindows({ ...f.deps, sleep: tick, detachLock: lockAt(store, (pid) => pid === process.pid) }, one);
			expect(writes(f.calls)).toEqual(["read"]);
			expect(pref.value).toBe("1");
			expect(store.getMeta(DETACH_PREF_META)).toBeUndefined();
			store.close();
		});

		test("a dead holder's `before` is inherited only while the setting still reads on", async () => {
			setup();
			const store = openStore(dbPath());
			store.setMeta(
				DETACH_PREF_META,
				JSON.stringify({
					phase: "set",
					before: "off",
					by: "999999:dead",
					at: T,
					holders: [{ token: "999999:dead", pid: 999_999, at: T }],
				})
			);
			// the user deleted it since the crash
			const pref: PrefBox = { value: undefined, atClose: [] };
			const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref });
			await hideSimWindows({ ...f.deps, sleep: tick, detachLock: lockAt(store, (pid) => pid === process.pid) }, one);
			expect(writes(f.calls)).toEqual(["read", "write", "delete"]);
			expect(pref.value).toBeUndefined();
			store.close();
		});

		test("a holder older than any hide can last is dropped even if its pid is alive again (reused)", async () => {
			setup();
			const store = openStore(dbPath());
			const old = T - hour;
			store.setMeta(
				DETACH_PREF_META,
				JSON.stringify({
					phase: "set",
					before: "unset",
					by: "4242:x",
					at: old,
					holders: [{ token: "4242:x", pid: 4242, at: old }],
				})
			);
			const pref: PrefBox = { value: undefined, atClose: [] };
			const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref });
			await hideSimWindows({ ...f.deps, sleep: tick, detachLock: lockAt(store, alive) }, one);
			expect(pref.atClose).toEqual(["1"]);
			expect(writes(f.calls)).toEqual(["read", "write", "delete"]);
			expect(store.getMeta(DETACH_PREF_META)).toBeUndefined();
			store.close();
		});

		test("a `setting` row older than any hide can last is taken over at once, not waited on", async () => {
			setup();
			const store = openStore(dbPath());
			const old = T - hour;
			store.setMeta(
				DETACH_PREF_META,
				JSON.stringify({ phase: "setting", by: "4242:x", at: old, holders: [{ token: "4242:x", pid: 4242, at: old }] })
			);
			const pref: PrefBox = { value: undefined, atClose: [] };
			const f = fakeSimulator(one, ["warden-iphone-17-1 – iOS 26.5"], {}, undefined, { pref });
			let waits = 0;
			const sleep = async (ms: number) => {
				if (ms === 50) waits++;
			};
			await hideSimWindows({ ...f.deps, sleep, detachLock: lockAt(store, alive) }, one);
			expect(waits).toBe(0);
			expect(f.warnings).toEqual([]);
			expect(writes(f.calls)).toEqual(["read", "write", "delete"]);
			expect(store.getMeta(DETACH_PREF_META)).toBeUndefined();
			store.close();
		});
	});

	describe("heartbeat (a live hold longer than the TTL)", () => {
		const T = 1_800_000_000_000;
		const sec = 1000;
		const titleA = ["warden-iphone-17-1 – iOS 26.5"];
		const titleB = ["warden-iphone-17-2 – iOS 26.5"];

		/** A's close shuts U1 down; `boot` / `bootstatus` move the shared clock and may run hide B meanwhile. */
		const longHold = (
			clock: { now: number },
			step: { bootSec: number; statusSec: number },
			duringStatus: () => Promise<void>
		) => {
			const pref: PrefBox = { value: undefined, atClose: [] };
			const a = fakeSimulator(one, titleA, { U1: "Shutdown" }, undefined, {
				pref,
				boot: async () => {
					clock.now += step.bootSec * sec;
					return done();
				},
				bootstatus: async () => {
					clock.now += step.statusSec * sec;
					await duringStatus();
					return done();
				},
			});
			return { pref, a };
		};

		test("a holder that heartbeats is still live past the TTL: a hide joining then leaves the restore to it", async () => {
			setup();
			const storeA = openStore(dbPath());
			const storeB = openStore(dbPath());
			const clock = { now: T };
			const lock = (store: typeof storeA) => ({ store, pid: process.pid, pidAlive: alive, now: () => clock.now });
			let b: ReturnType<typeof fakeSimulator> | undefined;
			// A joined at T; by B's arrival 400 s have passed, more than the 300 s TTL
			const { pref, a } = longHold(clock, { bootSec: 200, statusSec: 200 }, async () => {
				b = fakeSimulator(two, titleB, {}, undefined, { pref });
				await hideSimWindows({ ...b.deps, sleep: tick, detachLock: lock(storeB) }, two);
			});
			const out = await hideSimWindows({ ...a.deps, sleep: tick, detachLock: lock(storeA) }, one);
			expect(out.rebooted).toEqual(["warden-iphone-17-1"]);
			// B joined A's hold: it never read or wrote the setting, and A, last out, put the user's unset back
			expect(b && writes(b.calls)).toEqual([]);
			expect(writes(a.calls)).toEqual(["read", "write", "delete"]);
			// A's close, B's close, A's close of the window reattached after its reboot: all with the setting on
			expect(pref.atClose).toEqual(["1", "1", "1"]);
			expect(pref.value).toBeUndefined();
			expect(storeA.getMeta(DETACH_PREF_META)).toBeUndefined();
			storeA.close();
			storeB.close();
		});

		test("a holder that stops heartbeating for longer than the TTL is dropped even though its pid is alive", async () => {
			setup();
			const storeA = openStore(dbPath());
			const storeB = openStore(dbPath());
			const clock = { now: T };
			const lock = (store: typeof storeA) => ({ store, pid: process.pid, pidAlive: alive, now: () => clock.now });
			let b: ReturnType<typeof fakeSimulator> | undefined;
			// one step (bootstatus) silent for 400 s
			const { a } = longHold(clock, { bootSec: 0, statusSec: 400 }, async () => {
				b = fakeSimulator(two, titleB, {}, undefined, { pref: { value: "1", atClose: [] } });
				await hideSimWindows({ ...b.deps, sleep: tick, detachLock: lock(storeB) }, two);
			});
			await hideSimWindows({ ...a.deps, sleep: tick, detachLock: lock(storeA) }, one);
			// B took the row over (it read the setting itself): A no longer counted
			expect(b && writes(b.calls)).toEqual(["read"]);
			storeA.close();
			storeB.close();
		});

		test("`simctl boot` and `simctl list` are bounded, so no step between heartbeats is unbounded", async () => {
			const f = fakeSimulator(one, titleA, { U1: "Shutdown" }, undefined);
			const timeouts = new Map<string, number | undefined>();
			const exec: Exec = (cmd, opts) => {
				if (cmd[0] === "xcrun") timeouts.set(cmd.slice(0, 3).join(" "), opts?.timeoutMs);
				return f.deps.exec(cmd, opts);
			};
			await hideSimWindows({ ...f.deps, exec }, one);
			expect(timeouts.get("xcrun simctl boot")).toBe(IOS_TIMEOUTS.bootMs);
			expect(timeouts.get("xcrun simctl list")).toBe(IOS_TIMEOUTS.listMs);
		});
	});
});
