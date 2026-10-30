import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLevel, parsePermissionPairs, parsePushPayload, parseTextSizeArg } from "./settings-parse";

describe("parsePermissionPairs", () => {
	test("name=state pairs", () => {
		const r = parsePermissionPairs(["location=denied", "camera=granted"]);
		expect(r.success && r.data).toEqual({ location: "denied", camera: "granted" });
	});
	test("rejects no pairs, a bad shape, an unknown name or state, and a repeat", () => {
		expect(parsePermissionPairs([]).success).toBe(false);
		expect(parsePermissionPairs(["location"]).success).toBe(false);
		expect(parsePermissionPairs(["a=b=c"]).success).toBe(false);
		const name = parsePermissionPairs(["wifi=granted"]);
		expect(!name.success && name.error).toContain("unknown permission");
		const state = parsePermissionPairs(["camera=maybe"]);
		expect(!state.success && state.error).toContain("not a state");
		expect(parsePermissionPairs(["camera=granted", "camera=denied"]).success).toBe(false);
	});
});

describe("parseTextSizeArg and parseLevel", () => {
	test("a name or a scale", () => {
		expect(parseTextSizeArg("accessibility-large")).toEqual({ success: true, data: "accessibility-large" });
		expect(parseTextSizeArg("1.5")).toEqual({ success: true, data: 1.5 });
		expect(parseTextSizeArg("0").success).toBe(false);
		expect(parseTextSizeArg("huge").success).toBe(false);
	});
	test("level is a whole number 0-100", () => {
		expect(parseLevel("42")).toEqual({ success: true, data: 42 });
		for (const bad of ["", "101", "-1", "1.5", "x"]) expect(parseLevel(bad).success).toBe(false);
	});
});

describe("parsePushPayload", () => {
	test("inline JSON or a file", () => {
		const inline = parsePushPayload('{"aps":{"alert":"hi"}}', "/");
		expect(inline.success && inline.data.aps).toEqual({ alert: "hi" });
		const dir = mkdtempSync(join(tmpdir(), "wdn-push-"));
		writeFileSync(join(dir, "p.json"), '{"aps":{"badge":1},"custom":true}');
		const file = parsePushPayload("p.json", dir);
		expect(file.success && file.data).toEqual({ aps: { badge: 1 }, custom: true });
	});
	test("rejects a missing file, bad JSON, a non-object and a payload without aps", () => {
		expect(parsePushPayload("nope.json", "/tmp").success).toBe(false);
		expect(parsePushPayload("{nope", "/").success).toBe(false);
		expect(parsePushPayload("{}", "/").success).toBe(false);
		expect(parsePushPayload('{"aps":1}', "/").success).toBe(false);
	});
});
