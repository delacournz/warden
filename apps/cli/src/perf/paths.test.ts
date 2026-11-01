import { describe, expect, test } from "bun:test";
import { perfPaths } from "@delacour/warden-sdk/ops/perf/paths";

describe("displayPath", () => {
	test("inside the cwd: relative", () => {
		expect(perfPaths.displayPath({ cwd: "/repo" }, "/repo/out/cpu.cpuprofile")).toBe("out/cpu.cpuprofile");
	});

	test("outside the cwd: absolute, never ../../..", () => {
		expect(perfPaths.displayPath({ cwd: "/repo/apps/x" }, "/Users/me/.warden/perf/s1/native/ios.trace")).toBe(
			"/Users/me/.warden/perf/s1/native/ios.trace"
		);
	});

	test("the cwd itself: absolute", () => {
		expect(perfPaths.displayPath({ cwd: "/repo" }, "/repo")).toBe("/repo");
	});
});
