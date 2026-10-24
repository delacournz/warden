import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { iosPredicate, iosShowArgv, iosStreamArgv, parseCompactLine } from "./ios-log";

const lines = readFileSync(new URL("../../fixtures/log-stream-compact.txt", import.meta.url), "utf8").split("\n");

describe("parseCompactLine", () => {
	test("subsystem becomes the tag", () => {
		expect(parseCompactLine(lines[2] ?? "")).toEqual({
			ts: "2026-10-24 10:00:01.123",
			tsMs: Date.UTC(2026, 9, 24, 10, 0, 1, 123),
			pid: 4321,
			tid: 0x1a2b3c,
			level: "I",
			tag: "com.acme.shop:network",
			msg: "GET https://api.acme.shop/v1/cart?api_key=sk_live_51Hxyz",
		});
	});

	test("type codes map to levels", () => {
		expect(parseCompactLine(lines[3] ?? "")?.level).toBe("D");
		expect(parseCompactLine(lines[4] ?? "")?.level).toBe("I");
		expect(parseCompactLine(lines[5] ?? "")?.level).toBe("E");
		expect(parseCompactLine(lines[7] ?? "")?.level).toBe("F");
	});

	test("no subsystem falls back to the process name", () => {
		expect(parseCompactLine(lines[6] ?? "")).toMatchObject({ tag: "ShopApp", msg: "plain message with no subsystem" });
	});

	test("headers are skipped", () => {
		expect(parseCompactLine(lines[0] ?? "")).toBeUndefined();
		expect(parseCompactLine(lines[1] ?? "")).toBeUndefined();
	});
});

describe("argv", () => {
	test("predicate covers subsystem, sub-subsystems and the executable", () => {
		expect(iosPredicate("com.acme.shop", "ShopApp")).toBe(
			'subsystem == "com.acme.shop" OR subsystem BEGINSWITH "com.acme.shop" OR process == "ShopApp"'
		);
	});

	test("quotes in names cannot break out of the predicate", () => {
		expect(iosPredicate('a"b', "x")).toContain('"a\\"b"');
	});

	test("stream and show", () => {
		expect(iosStreamArgv("P")).toEqual(["log", "stream", "--style", "compact", "--level", "info", "--predicate", "P"]);
		expect(iosShowArgv("P", "5m")).toEqual([
			"log",
			"show",
			"--style",
			"compact",
			"--info",
			"--last",
			"5m",
			"--predicate",
			"P",
		]);
	});
});
