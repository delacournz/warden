import { describe, expect, test } from "bun:test";
import type { Exec } from "@delacour/warden-core/exec";
import { arrangeSimWindows, autoArrangeSimWindows, deviceName, layoutWindows, type SimWindow } from "./sim-windows";

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
		expect(calls).toHaveLength(2);
		expect(calls[1]?.slice(0, 4)).toEqual(["osascript", "-l", "JavaScript", "-e"]);
		expect(JSON.parse(calls[1]?.[5] ?? "")).toEqual([
			{ title: "warden-iphone-17-1 – iOS 26.5", x: 0, y: 33 },
			{ title: "warden-iphone-17-2 – iOS 26.5", x: 464, y: 33 },
		]);
	});

	test("no warden windows → no move call", async () => {
		const calls: string[][] = [];
		const result = await arrangeSimWindows(scripted(JSON.stringify({ screen, windows: [] }), calls));
		expect(result).toEqual({ success: true, data: { arranged: [] } });
		expect(calls).toHaveLength(1);
	});

	test("osascript failure → error mentioning Accessibility", async () => {
		const exec: Exec = async () => ({ exitCode: 1, stdout: "", stderr: "not allowed assistive access. (-1719)" });
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
		expect(fake.calls).toHaveLength(1);
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
