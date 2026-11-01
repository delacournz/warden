import { describe, expect, test } from "bun:test";
import { resolveHeadless } from "./headless";

describe("resolveHeadless", () => {
	test("flag wins over config and env", () => {
		expect(resolveHeadless({ flag: false, config: true, env: { WARDEN_HEADLESS: "1" } })).toBe(false);
		expect(resolveHeadless({ flag: true, config: false, env: {} })).toBe(true);
	});

	test("config wins over env", () => {
		expect(resolveHeadless({ config: false, env: { WARDEN_HEADLESS: "1" } })).toBe(false);
		expect(resolveHeadless({ config: true, env: {} })).toBe(true);
	});

	test("WARDEN_HEADLESS=1 / true is the fallback; anything else is off", () => {
		expect(resolveHeadless({ env: { WARDEN_HEADLESS: "1" } })).toBe(true);
		expect(resolveHeadless({ env: { WARDEN_HEADLESS: "true" } })).toBe(true);
		expect(resolveHeadless({ env: { WARDEN_HEADLESS: "0" } })).toBe(false);
		expect(resolveHeadless({ env: {} })).toBe(false);
	});
});
