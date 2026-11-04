import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostToken, uplinkApi } from "./uplink-run";

describe("hostToken", () => {
	test("--token-file, else WARDEN_HOST_TOKEN, else a message naming both", () => {
		const dir = mkdtempSync(join(tmpdir(), "wtok-"));
		const file = join(dir, "t");
		writeFileSync(file, "from-file\n");
		expect(hostToken({ WARDEN_HOST_TOKEN: "env" }, file)).toEqual({ success: true, data: "from-file" });
		expect(hostToken({ WARDEN_HOST_TOKEN: " env " }, undefined)).toEqual({ success: true, data: "env" });
		const none = hostToken({}, undefined);
		expect(none.success ? "" : none.error).toContain("WARDEN_HOST_TOKEN");
		const missing = hostToken({}, join(dir, "nope"));
		expect(missing.success).toBe(false);
	});
});

describe("uplinkApi", () => {
	test("--api, else WARDEN_API_URL, trailing slashes off", () => {
		expect(uplinkApi({ WARDEN_API_URL: "http://b/" }, "http://a//")).toBe("http://a");
		expect(uplinkApi({ WARDEN_API_URL: "http://b/" }, undefined)).toBe("http://b");
	});
});
