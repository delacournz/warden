import { describe, expect, test } from "bun:test";
import { redactSecrets, resolveText, secretsFromEnv } from "./secrets";

describe("redaction", () => {
	const env = { WARDEN_UI_SECRET_PASSWORD: "hunter2", WARDEN_UI_SECRET_EMPTY: "", HOME: "/Users/x" };

	test("reads only non-empty WARDEN_UI_SECRET_* values", () => {
		expect(secretsFromEnv(env)).toEqual([{ name: "PASSWORD", value: "hunter2" }]);
	});

	test("a text equal to a secret value is stored as its name", () => {
		expect(redactSecrets("hunter2", env)).toEqual({ secret: "PASSWORD" });
	});

	test("other text, and text that merely contains a secret, stays literal", () => {
		expect(redactSecrets("hello", env)).toBe("hello");
	});

	test("resolveText returns literals and looks secrets up in env", () => {
		expect(resolveText("hello", env)).toEqual({ success: true, data: "hello" });
		expect(resolveText({ secret: "PASSWORD" }, env)).toEqual({ success: true, data: "hunter2" });
		const missing = resolveText({ secret: "TOKEN" }, env);
		expect(missing.success).toBe(false);
		if (!missing.success) expect(missing.error).toContain("WARDEN_UI_SECRET_TOKEN");
	});
});
