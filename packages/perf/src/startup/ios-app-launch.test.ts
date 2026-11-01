import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { iosAppLaunch } from "./ios-app-launch";

const fx = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "fixtures", name), "utf8");

describe("simctl", () => {
	test("pid from launch output", () => {
		expect(iosAppLaunch.parseSimctlLaunch("com.acme.shop: 4242\n")).toBe(4242);
		expect(iosAppLaunch.parseSimctlLaunch("")).toBeUndefined();
	});
	test("argv", () => {
		expect(iosAppLaunch.simctlLaunchArgv("U1", "com.acme.shop", true)).toEqual([
			"xcrun",
			"simctl",
			"launch",
			"--terminate-running-process",
			"U1",
			"com.acme.shop",
		]);
		expect(iosAppLaunch.simctlLaunchArgv("U1", "b", false)).toEqual(["xcrun", "simctl", "launch", "U1", "b"]);
	});
});

describe("xctrace (spike)", () => {
	test("record argv launches the .app under the App Launch template", () => {
		const argv = iosAppLaunch.xctraceLaunchArgv("U1", "/x/Shop.app", "/t/a.trace");
		expect(argv.slice(0, 5)).toEqual(["xcrun", "xctrace", "record", "--template", "App Launch"]);
		expect(argv.slice(-3)).toEqual(["--launch", "--", "/x/Shop.app"]);
		expect(argv).toContain("--no-prompt");
	});

	test("export xpath names the schema", () => {
		expect(iosAppLaunch.xctraceTableArgv("/t/a.trace", "life-cycle-period").at(-1)).toBe(
			'/trace-toc/run[@number="1"]/data/table[@schema="life-cycle-period"]'
		);
	});

	test("picks the launch schema from the toc", () => {
		expect(iosAppLaunch.pickLaunchSchema(fx("xctrace-toc-app-launch.xml"))).toBe("life-cycle-period");
		expect(iosAppLaunch.pickLaunchSchema("<trace-toc/>")).toBeUndefined();
	});

	test("parses periods, resolving ref cells", () => {
		const r = iosAppLaunch.parseLaunchPeriods(fx("xctrace-export-life-cycle-period.xml"));
		expect(r).toEqual({
			success: true,
			data: [
				{ name: "Total App Launch", durationMs: 1620 },
				{ name: "Process Creation", durationMs: 410 },
				{ name: "Initial Frame Rendering", durationMs: 1210 },
			],
		});
	});

	test("launch duration prefers Total App Launch, else the longest launch period", () => {
		expect(
			iosAppLaunch.launchDurationMs([
				{ name: "Process Creation", durationMs: 410 },
				{ name: "Total App Launch", durationMs: 1620 },
			])
		).toBe(1620);
		expect(
			iosAppLaunch.launchDurationMs([
				{ name: "Launch A", durationMs: 5 },
				{ name: "Launch B", durationMs: 9 },
			])
		).toBe(9);
		expect(iosAppLaunch.launchDurationMs([{ name: "Process Creation", durationMs: 410 }])).toBeUndefined();
	});

	test("empty export fails", () => {
		expect(iosAppLaunch.parseLaunchPeriods("<trace-query-result/>").success).toBe(false);
	});
});
