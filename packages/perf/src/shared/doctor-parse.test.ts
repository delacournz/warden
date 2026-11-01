import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { doctorParser } from "./doctor-parse";

const fx = (name: string) => readFileSync(join(import.meta.dir, "..", "..", "fixtures", name), "utf8");

describe("host tool versions", () => {
	test("xctrace version", () => {
		expect(doctorParser.parseXctraceVersion(fx("xctrace-version.txt"))).toBe("27.1");
		expect(doctorParser.parseXctraceVersion("garbage")).toBeUndefined();
	});

	test("xcodebuild -version", () => {
		expect(doctorParser.parseXcodeVersion(fx("xcodebuild-version.txt"))).toEqual({
			major: 27,
			minor: 1,
			patch: 0,
			text: "27.1",
		});
		expect(doctorParser.parseXcodeVersion("Xcode 26.4.1\nBuild version 17E1")).toEqual({
			major: 26,
			minor: 4,
			patch: 1,
			text: "26.4.1",
		});
		expect(doctorParser.parseXcodeVersion("nope")).toBeUndefined();
	});

	test("adb version", () => {
		expect(doctorParser.parseAdbVersion(fx("adb-version.txt"))).toBe("1.0.41");
	});
});

describe("xctrace --device deadlock (Xcode 26.4+)", () => {
	test("flags 26.4 and later only", () => {
		const v = (major: number, minor: number) => ({ major, minor, patch: 0, text: `${major}.${minor}` });
		expect(doctorParser.xctraceDeviceDeadlock(v(26, 3))).toBe(false);
		expect(doctorParser.xctraceDeviceDeadlock(v(26, 4))).toBe(true);
		expect(doctorParser.xctraceDeviceDeadlock(v(27, 1))).toBe(true);
		expect(doctorParser.xctraceDeviceDeadlock(v(25, 9))).toBe(false);
	});
});

describe("adb shell which perfetto simpleperf", () => {
	test("tells which tools exist on the device", () => {
		expect(doctorParser.parseDeviceTools(fx("adb-which-both.txt"))).toEqual({ perfetto: true, simpleperf: true });
		expect(doctorParser.parseDeviceTools(fx("adb-which-perfetto.txt"))).toEqual({ perfetto: true, simpleperf: false });
		expect(doctorParser.parseDeviceTools("")).toEqual({ perfetto: false, simpleperf: false });
	});
});
