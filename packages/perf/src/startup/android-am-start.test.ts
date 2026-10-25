import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	amStartArgv,
	parseAmStart,
	parseFullyDrawn,
	parseResolveActivity,
	resolveActivityArgv,
} from "./android-am-start";

const fx = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "fixtures", name), "utf8");

describe("parseAmStart", () => {
	test("cold start", () => {
		expect(parseAmStart(fx("am-start-cold.txt"))).toEqual({
			success: true,
			data: { totalMs: 1834, waitMs: 1851, launchState: "COLD", activity: "com.acme.shop/.MainActivity" },
		});
	});

	test("hot start", () => {
		const r = parseAmStart(fx("am-start-warm.txt"));
		expect(r.success && r.data).toMatchObject({ launchState: "HOT", totalMs: 312, waitMs: 318 });
	});

	test("older ThisTime line is kept", () => {
		const r = parseAmStart(fx("am-start-warm-thistime.txt"));
		expect(r.success && r.data).toMatchObject({ launchState: "WARM", thisMs: 640, totalMs: 702 });
	});

	test("falls back to WaitTime without TotalTime", () => {
		const r = parseAmStart("Status: ok\nWaitTime: 90\nComplete\n");
		expect(r.success && r.data.totalMs).toBe(90);
	});

	test("Error output fails with the system's message", () => {
		const r = parseAmStart(fx("am-start-error.txt"));
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error).toContain("does not exist");
	});

	test("non-ok status fails", () => {
		const r = parseAmStart("Status: timeout\nWaitTime: 10000\n");
		expect(r).toEqual({ success: false, error: "am start reported Status: timeout" });
	});

	test("no timing at all fails", () => {
		expect(parseAmStart("Starting: Intent {}\nComplete\n").success).toBe(false);
	});
});

describe("argv", () => {
	test("cold stops the app first (-S), warm does not", () => {
		expect(amStartArgv("a/.B", true)).toEqual(["shell", "am", "start", "-W", "-S", "-n", "a/.B"]);
		expect(amStartArgv("a/.B", false)).toEqual(["shell", "am", "start", "-W", "-n", "a/.B"]);
		expect(resolveActivityArgv("a")).toEqual(["shell", "cmd", "package", "resolve-activity", "--brief", "a"]);
	});
});

describe("parseResolveActivity", () => {
	test("last line is the component", () => {
		expect(parseResolveActivity(fx("resolve-activity.txt"))).toBe("com.acme.shop/.MainActivity");
	});
	test("no launcher activity", () => {
		expect(parseResolveActivity(fx("resolve-activity-none.txt"))).toBeUndefined();
	});
});

describe("parseFullyDrawn", () => {
	test("reads every Fully drawn line, durations with minutes", () => {
		expect(parseFullyDrawn(fx("logcat-fully-drawn.txt"))).toEqual([
			{ component: "com.acme.shop/.MainActivity", ms: 3641 },
			{ component: "com.other.app/.HomeActivity", ms: 620 },
			{ component: "com.acme.shop/.MainActivity", ms: 62_005 },
		]);
	});
	test("nothing when the app never reports", () => {
		expect(parseFullyDrawn("--------- beginning of main\n")).toEqual([]);
	});
});
