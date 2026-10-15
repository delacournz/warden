import { describe, expect, test } from "bun:test";
import { el, snapshotOf } from "../driver.testing";
import {
	createLineSplitter,
	elementAtPointDataSchema,
	encodeRequest,
	healthDataSchema,
	mapWireError,
	parseLine,
	protocolVersion,
	settleDataSchema,
	snapshotDataSchema,
} from "./simd-protocol";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("parseLine", () => {
	test("ready, log and fatal events", () => {
		const ready = parseLine(
			JSON.stringify({
				event: "ready",
				protocol: protocolVersion,
				version: "1",
				udid: "U",
				hid: { transport: "indigo" },
				ax: { default: "axbridge", bridge: "available" },
				screen: { width: 390, height: 844, scale: 3 },
			})
		);
		expect(ready.success && ready.message.kind === "event" && ready.message.event.event).toBe("ready");
		const log = parseLine('{"event":"log","level":"warn","message":"fell back","op":"snapshot","id":"4"}');
		expect(log.success && log.message.kind === "event" && log.message.event).toMatchObject({ level: "warn", id: "4" });
		const fatal = parseLine('{"event":"fatal","error":{"code":"E_NOT_BOOTED","message":"sim is shut down"}}');
		expect(fatal.success && fatal.message.kind === "event" && fatal.message.event.event).toBe("fatal");
	});

	test("ok and error responses", () => {
		const ok = parseLine('{"id":"1","ok":true,"data":{"a":1}}');
		expect(ok.success && ok.message.kind === "response" && ok.message.response).toEqual({
			id: "1",
			ok: true,
			data: { a: 1 },
		});
		const bad = parseLine('{"id":"2","ok":false,"error":{"code":"E_HID","message":"x","retryable":true}}');
		expect(bad.success && bad.message.kind === "response" && bad.message.response.ok).toBe(false);
	});

	test("garbage is rejected with a reason", () => {
		expect(parseLine("not json")).toEqual({ success: false, reason: "not JSON" });
		expect(parseLine('{"event":"nope"}').success).toBe(false);
		expect(parseLine('{"id":1}').success).toBe(false);
		expect(parseLine('"string"').success).toBe(false);
	});
});

describe("createLineSplitter", () => {
	test("splits lines, keeps partial tails, drops blanks and CR", () => {
		const splitter = createLineSplitter();
		expect(splitter.push(bytes('{"a":1}\n{"b"'))).toEqual(['{"a":1}']);
		expect(splitter.push(bytes(":2}\r\n\n\n"))).toEqual(['{"b":2}']);
		expect(splitter.rest()).toBe("");
		expect(splitter.push(bytes("tail"))).toEqual([]);
		expect(splitter.rest()).toBe("tail");
	});

	test("a UTF-8 sequence split across chunks survives", () => {
		const splitter = createLineSplitter();
		const all = bytes("é\n");
		expect(splitter.push(all.slice(0, 1))).toEqual([]);
		expect(splitter.push(all.slice(1))).toEqual(["é"]);
	});

	test("many lines in one chunk", () => {
		expect(createLineSplitter().push(bytes("a\nb\nc\n"))).toEqual(["a", "b", "c"]);
	});
});

describe("mapWireError", () => {
	test("known codes pass through with the wire retryable flag", () => {
		expect(mapWireError({ code: "E_HID", message: "boom", retryable: true })).toMatchObject({
			code: "E_HID",
			retryable: true,
		});
		expect(mapWireError({ code: "E_TIMEOUT", message: "slow" }).retryable).toBe(true);
	});

	test("E_UNKNOWN_UDID is E_UNKNOWN_DEVICE", () => {
		expect(mapWireError({ code: "E_UNKNOWN_UDID", message: "no such sim" }).code).toBe("E_UNKNOWN_DEVICE");
	});

	test("unknown codes become E_INTERNAL and keep the original", () => {
		const error = mapWireError({ code: "E_WEIRD", message: "?", detail: { a: 1 } });
		expect(error.code).toBe("E_INTERNAL");
		expect(error.detail).toEqual({ wireCode: "E_WEIRD", wireDetail: { a: 1 } });
	});

	test("detail is kept for E_UNSUPPORTED_TEXT", () => {
		expect(mapWireError({ code: "E_UNSUPPORTED_TEXT", message: "é", detail: { rest: "é" } }).detail).toEqual({
			rest: "é",
		});
	});
});

describe("data schemas", () => {
	test("snapshot data accepts a normalized element tree", () => {
		const snap = snapshotOf([el("window", { children: [el("button", { id: "go", label: "Go" })] })]);
		const parsed = snapshotDataSchema.safeParse({
			backend: "axbridge",
			screen: snap.screen,
			truncated: false,
			elements: JSON.parse(JSON.stringify(snap.elements)),
			ms: 31,
		});
		expect(parsed.success).toBe(true);
		expect(parsed.success && parsed.data.elements[0]?.children[0]?.identifier).toBe("go");
	});

	test("snapshot data rejects an unknown role", () => {
		const snap = snapshotOf([el("button")]);
		const elements = JSON.parse(JSON.stringify(snap.elements));
		elements[0].role = "frobnicator";
		expect(
			snapshotDataSchema.safeParse({ backend: "ax", screen: snap.screen, truncated: false, elements, ms: 1 }).success
		).toBe(false);
	});

	test("elementAtPoint may be null; settle and health shapes", () => {
		expect(elementAtPointDataSchema.safeParse(null).success).toBe(true);
		expect(settleDataSchema.safeParse({ quiet: true, waitedMs: 12 }).success).toBe(true);
		expect(settleDataSchema.safeParse({ quiet: "yes" }).success).toBe(false);
		expect(
			healthDataSchema.safeParse({
				version: "1",
				udid: "U",
				hid: { transport: "dtuhid" },
				ax: { default: "axbridge", bridge: "available" },
				screen: { width: 1, height: 2, scale: 3 },
				extra: "kept",
			}).success
		).toBe(true);
	});
});

test("encodeRequest is one JSON line", () => {
	expect(encodeRequest({ id: "1", op: "tap", x: 1, y: 2 })).toBe('{"id":"1","op":"tap","x":1,"y":2}\n');
});
