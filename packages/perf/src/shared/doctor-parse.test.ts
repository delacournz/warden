import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	parseAdbVersion,
	parseDeviceTools,
	parseXcodeVersion,
	parseXctraceVersion,
	xctraceDeviceDeadlock,
} from "./doctor-parse";

const fx = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "fixtures", name), "utf8");

describe("host tool versions", () => {
	test("xctrace version", () => {
		expect(parseXctraceVersion(fx("xctrace-version.txt"))).toBe("27.1");
		expect(parseXctraceVersion("garbage")).toBeUndefined();
	});

	test("xcodebuild -version", () => {
		expect(parseXcodeVersion(fx("xcodebuild-version.txt"))).toEqual({ major: 27, minor: 1, patch: 0, text: "27.1" });
		expect(parseXcodeVersion("Xcode 26.4.1\nBuild version 17E1")).toEqual({
			major: 26,
			minor: 4,
			patch: 1,
			text: "26.4.1",
		});
		expect(parseXcodeVersion("nope")).toBeUndefined();
	});

	test("adb version", () => {
		expect(parseAdbVersion(fx("adb-version.txt"))).toBe("1.0.41");
	});
});

describe("xctrace --device deadlock (Xcode 26.4+)", () => {
	test("flags 26.4 and later only", () => {
		const v = (major: number, minor: number) => ({ major, minor, patch: 0, text: `${major}.${minor}` });
		expect(xctraceDeviceDeadlock(v(26, 3))).toBe(false);
		expect(xctraceDeviceDeadlock(v(26, 4))).toBe(true);
		expect(xctraceDeviceDeadlock(v(27, 1))).toBe(true);
		expect(xctraceDeviceDeadlock(v(25, 9))).toBe(false);
	});
});

describe("adb shell which perfetto simpleperf", () => {
	test("tells which tools exist on the device", () => {
		expect(parseDeviceTools(fx("adb-which-both.txt"))).toEqual({ perfetto: true, simpleperf: true });
		expect(parseDeviceTools(fx("adb-which-perfetto.txt"))).toEqual({ perfetto: true, simpleperf: false });
		expect(parseDeviceTools("")).toEqual({ perfetto: false, simpleperf: false });
	});
});
