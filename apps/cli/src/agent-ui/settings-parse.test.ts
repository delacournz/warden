import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uiSettingsParse } from "./settings-parse";

describe("parsePermissionPairs", () => {
	test("name=state pairs", () => {
		const r = uiSettingsParse.parsePermissionPairs(["location=denied", "camera=granted"]);
		expect(r.success && r.data).toEqual({ location: "denied", camera: "granted" });
	});
	test("rejects no pairs, a bad shape, an unknown name or state, and a repeat", () => {
		expect(uiSettingsParse.parsePermissionPairs([]).success).toBe(false);
		expect(uiSettingsParse.parsePermissionPairs(["location"]).success).toBe(false);
		expect(uiSettingsParse.parsePermissionPairs(["a=b=c"]).success).toBe(false);
		const name = uiSettingsParse.parsePermissionPairs(["wifi=granted"]);
		expect(!name.success && name.error).toContain("unknown permission");
		const state = uiSettingsParse.parsePermissionPairs(["camera=maybe"]);
		expect(!state.success && state.error).toContain("not a state");
		expect(uiSettingsParse.parsePermissionPairs(["camera=granted", "camera=denied"]).success).toBe(false);
	});
});

describe("parseTextSizeArg and parseLevel", () => {
	test("a name or a scale", () => {
		expect(uiSettingsParse.parseTextSizeArg("accessibility-large")).toEqual({
			success: true,
			data: "accessibility-large",
		});
		expect(uiSettingsParse.parseTextSizeArg("1.5")).toEqual({ success: true, data: 1.5 });
		expect(uiSettingsParse.parseTextSizeArg("0").success).toBe(false);
		expect(uiSettingsParse.parseTextSizeArg("huge").success).toBe(false);
	});
	test("level is a whole number 0-100", () => {
		expect(uiSettingsParse.parseLevel("42")).toEqual({ success: true, data: 42 });
		for (const bad of ["", "101", "-1", "1.5", "x"]) expect(uiSettingsParse.parseLevel(bad).success).toBe(false);
	});
});

describe("parsePushPayload", () => {
	test("inline JSON or a file", () => {
		const inline = uiSettingsParse.parsePushPayload('{"aps":{"alert":"hi"}}', "/");
		expect(inline.success && inline.data.aps).toEqual({ alert: "hi" });
		const dir = mkdtempSync(join(tmpdir(), "wdn-push-"));
		writeFileSync(join(dir, "p.json"), '{"aps":{"badge":1},"custom":true}');
		const file = uiSettingsParse.parsePushPayload("p.json", dir);
		expect(file.success && file.data).toEqual({ aps: { badge: 1 }, custom: true });
	});
	test("rejects a missing file, bad JSON, a non-object and a payload without aps", () => {
		expect(uiSettingsParse.parsePushPayload("nope.json", "/tmp").success).toBe(false);
		expect(uiSettingsParse.parsePushPayload("{nope", "/").success).toBe(false);
		expect(uiSettingsParse.parsePushPayload("{}", "/").success).toBe(false);
		expect(uiSettingsParse.parsePushPayload('{"aps":1}', "/").success).toBe(false);
	});
});
