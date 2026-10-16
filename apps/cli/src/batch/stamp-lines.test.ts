import { describe, expect, test } from "bun:test";
import { clockOf, lineStamper, unstamp } from "./stamp-lines";

/** 2026-10-15 09:05:03.007 local time */
const AT = new Date(2026, 9, 15, 9, 5, 3, 7);
const T = "[09:05:03.007] ";

describe("clockOf", () => {
	test("local HH:MM:SS.mmm, zero padded", () => {
		expect(clockOf(AT)).toBe("09:05:03.007");
		expect(clockOf(new Date(2026, 9, 15, 23, 51, 23, 412))).toBe("23:51:23.412");
	});
});

describe("lineStamper", () => {
	test("every line of a chunk gets the stamp; the trailing newline starts no line", () => {
		const stamp = lineStamper(() => AT);
		expect(stamp("a\nb\n")).toBe(`${T}a\n${T}b\n`);
		expect(stamp("c\n")).toBe(`${T}c\n`);
	});

	test("a line split across chunks is stamped once, at its start", () => {
		const stamp = lineStamper(() => AT);
		expect(stamp("hel")).toBe(`${T}hel`);
		expect(stamp("lo\nwor")).toBe(`lo\n${T}wor`);
		expect(stamp("ld\n")).toBe("ld\n");
	});

	test("an empty chunk writes nothing and keeps the state", () => {
		const stamp = lineStamper(() => AT);
		expect(stamp("")).toBe("");
		expect(stamp("x")).toBe(`${T}x`);
		expect(stamp("")).toBe("");
		expect(stamp("y\n")).toBe("y\n");
	});

	test("blank lines are stamped too; CRLF passes through", () => {
		const stamp = lineStamper(() => AT);
		expect(stamp("\n\n")).toBe(`${T}\n${T}\n`);
		expect(stamp("a\r\nb\r\n")).toBe(`${T}a\r\n${T}b\r\n`);
	});
});

describe("unstamp", () => {
	test("strips a leading stamp only", () => {
		expect(unstamp(`${T} ✓ |ios| e2e/a.e2e.ts`)).toBe(" ✓ |ios| e2e/a.e2e.ts");
		expect(unstamp(" ✓ [09:05:03.007] x")).toBe(" ✓ [09:05:03.007] x");
		expect(unstamp("plain")).toBe("plain");
	});
});
