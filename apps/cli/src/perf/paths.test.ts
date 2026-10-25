import { describe, expect, test } from "bun:test";
import { displayPath } from "./paths";

describe("displayPath", () => {
	test("inside the cwd: relative", () => {
		expect(displayPath({ cwd: "/repo" }, "/repo/out/cpu.cpuprofile")).toBe("out/cpu.cpuprofile");
	});

	test("outside the cwd: absolute, never ../../..", () => {
		expect(displayPath({ cwd: "/repo/apps/x" }, "/Users/me/.warden/perf/s1/native/ios.trace")).toBe(
			"/Users/me/.warden/perf/s1/native/ios.trace"
		);
	});

	test("the cwd itself: absolute", () => {
		expect(displayPath({ cwd: "/repo" }, "/repo")).toBe("/repo");
	});
});
