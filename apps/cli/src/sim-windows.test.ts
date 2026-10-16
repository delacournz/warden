import { describe, expect, test } from "bun:test";
import type { Exec } from "@delacour/warden-core/exec";
import { simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import {
	arrangeSimWindows,
	autoArrangeSimWindows,
	deviceName,
	hideSimWindows,
	layoutWindows,
	type SimWindow,
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
		expect(result).toEqual({ success: true, data: { arranged: ["warden-iphone-17-1", "warden-iphone-17-2"] } });
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
		expect(result).toEqual({ success: true, data: { arranged: [] } });
		expect(osascripts(calls)).toHaveLength(1);
	});

	test("Simulator.app not running (`pgrep -xq` finds nothing) → nothing to arrange, osascript never started", async () => {
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			return { exitCode: cmd[0] === "pgrep" ? 1 : 0, stdout: "", stderr: "" };
		};
		expect(await arrangeSimWindows(exec)).toEqual({ success: true, data: { arranged: [] } });
		expect(calls).toEqual([["pgrep", "-xq", "Simulator"]]);
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
		expect(await arrangeSimWindows(exec)).toEqual({ success: true, data: { arranged: [] } });
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

	test("Simulator.app not running → one pgrep, no osascript, no wait", async () => {
		const waits: number[] = [];
		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			return { exitCode: cmd[0] === "pgrep" ? 1 : 0, stdout: "", stderr: "" };
		};
		await autoArrangeSimWindows({ exec, env: {}, os: "darwin", sleep: async (ms) => void waits.push(ms) }, ["a"]);
		expect(calls).toEqual([["pgrep", "-xq", "Simulator"]]);
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
	detach: "0" | "1" | undefined
) {
	const calls: string[][] = [];
	const warnings: string[] = [];
	let lists = 0;
	const windows = () => JSON.stringify({ screen, windows: (titles ?? []).map((t) => sim(t)) });
	const list = () => {
		lists++;
		const sims = leased.map((d) => ({ udid: d.udid, name: d.name, state: stateAt(afterClose, d.udid, lists) }));
		return done(simctlDevicesJson({ "iOS-26-5": sims }));
	};
	const readPref = () => (detach === undefined ? done("", 1, "does not exist") : done(`${detach}\n`));
	const exec: Exec = async (cmd) => {
		calls.push([...cmd]);
		if (cmd[0] === "pgrep") return done("", titles === undefined ? 1 : 0);
		if (cmd[0] === "osascript") return done((cmd[4] ?? "").includes("NSScreen") ? windows() : "");
		if (cmd[0] === "defaults" && cmd[1] === "read") return readPref();
		return cmd.join(" ") === "xcrun simctl list devices -j" ? list() : done();
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

	test("Simulator.app not running → no close, never launched, not even an osascript (one `pgrep -xq` only)", async () => {
		const f = fake(undefined);
		expect(await hideSimWindows(f.deps, leased)).toEqual({ closed: [], rebooted: [] });
		expect(f.calls).toEqual([["pgrep", "-xq", "Simulator"]]);
		expect(closeCalls(f.calls)).toHaveLength(0);
		expect(f.calls.some((c) => c.join(" ").includes("open -a"))).toBe(false);
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
