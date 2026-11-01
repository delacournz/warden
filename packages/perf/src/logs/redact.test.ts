import { describe, expect, test } from "bun:test";
import { logRedactor } from "./redact";

describe("redact", () => {
	test("Authorization header, whole value", () => {
		expect(logRedactor.redact("I OkHttp: Authorization: Bearer abc123def456ghi")).toBe(
			"I OkHttp: Authorization: [redacted]"
		);
		expect(logRedactor.redact('headers {"Authorization": "Basic dXNlcjpwYXNz"}')).toBe(
			'headers {"Authorization": "[redacted]"}'
		);
	});

	test("bare bearer token", () => {
		expect(logRedactor.redact("sent token Bearer abcdefgh12345678 ok")).toBe("sent token Bearer [redacted] ok");
	});

	test("api key in query string and JSON", () => {
		expect(logRedactor.redact("GET /v1/items?api_key=sk_live_123&page=2")).toBe(
			"GET /v1/items?api_key=[redacted]&page=2"
		);
		expect(logRedactor.redact('{"apiKey":"sk_live_123","x":1}')).toBe('{"apiKey":"[redacted]","x":1}');
		expect(logRedactor.redact("api-key: abc")).toBe("api-key: [redacted]");
	});

	test("jwt", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
		expect(logRedactor.redact(`token=${jwt} done`)).toBe("token=[redacted] done");
	});

	test("emails and passwords", () => {
		expect(logRedactor.redact("login chris@delacour.co.nz failed")).toBe("login [redacted] failed");
		expect(logRedactor.redact("form password=hunter2&user=x")).toBe("form password=[redacted]&user=x");
	});

	test("leaves ordinary lines alone", () => {
		const line = '10-24 10:00:01.123  4321  4321 I ReactNativeJS: Running "main" with {rootTag: 1}';
		expect(logRedactor.redact(line)).toBe(line);
	});
});
