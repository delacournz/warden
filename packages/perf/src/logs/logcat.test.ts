import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseDeviceDate, parseThreadtime } from "./logcat";

const fixture = readFileSync(new URL("../../fixtures/logcat-app-threadtime.txt", import.meta.url), "utf8");
const lines = fixture.split("\n");

describe("parseThreadtime", () => {
	test("splits a line into fields", () => {
		expect(parseThreadtime(lines[1] ?? "", 2026)).toEqual({
			ts: "10-24 10:00:01.123",
			tsMs: Date.UTC(2026, 9, 24, 10, 0, 1, 123),
			pid: 4321,
			tid: 4321,
			level: "I",
			tag: "ReactNativeJS",
			msg: 'Running "main" with {"rootTag":1,"initialProps":{}}',
		});
	});

	test("padded tags and distinct tid", () => {
		const e = parseThreadtime(lines[2] ?? "", 2026);
		expect(e).toMatchObject({ tag: "OkHttp", tid: 4350, level: "D" });
		expect(e?.msg.startsWith("--> GET")).toBe(true);
	});

	test("tag holding a colon splits at the first one", () => {
		expect(parseThreadtime(lines[6] ?? "", 2026)).toMatchObject({
			tag: "unknown",
			msg: "React: Invalid prop `style` supplied to `View`",
		});
	});

	test("buffer headers and blanks are skipped", () => {
		expect(parseThreadtime(lines[0] ?? "", 2026)).toBeUndefined();
		expect(parseThreadtime("", 2026)).toBeUndefined();
	});
});

test("parseDeviceDate reads the device wall clock", () => {
	expect(parseDeviceDate("2026-10-24 10:05:30\n")).toBe(Date.UTC(2026, 9, 24, 10, 5, 30));
	expect(parseDeviceDate("nope")).toBeUndefined();
});
