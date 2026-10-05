import { describe, expect, test } from "bun:test";
import { validateCredentials } from "./credentials";

describe("validateCredentials", () => {
	test("accepts a valid email and 8+ char password", () => {
		expect(validateCredentials({ email: "ada@example.com", password: "password1" })).toEqual({ ok: true });
	});

	test("flags an invalid email", () => {
		const result = validateCredentials({ email: "ada", password: "password1" });
		expect(result).toEqual({ ok: false, field: "email", message: "Enter a valid email address." });
	});

	test("flags a short password", () => {
		const result = validateCredentials({ email: "ada@example.com", password: "short" });
		expect(result).toEqual({ ok: false, field: "password", message: "Password must be at least 8 characters." });
	});

	test("rejects the demo locked account with a form-level error", () => {
		const result = validateCredentials({ email: "locked@example.com", password: "password1" });
		expect(result).toEqual({ ok: false, field: "form", message: "This account is locked. Try another email." });
	});
});
