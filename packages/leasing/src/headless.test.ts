import { describe, expect, test } from "bun:test";
import { headlessResolver } from "./headless";

describe("resolveHeadless", () => {
	test("flag wins over config and env", () => {
		expect(headlessResolver.resolve({ flag: false, config: true, env: { WARDEN_HEADLESS: "1" } })).toBe(false);
		expect(headlessResolver.resolve({ flag: true, config: false, env: {} })).toBe(true);
	});

	test("config wins over env", () => {
		expect(headlessResolver.resolve({ config: false, env: { WARDEN_HEADLESS: "1" } })).toBe(false);
		expect(headlessResolver.resolve({ config: true, env: {} })).toBe(true);
	});

	test("WARDEN_HEADLESS=1 / true is the fallback; anything else is off", () => {
		expect(headlessResolver.resolve({ env: { WARDEN_HEADLESS: "1" } })).toBe(true);
		expect(headlessResolver.resolve({ env: { WARDEN_HEADLESS: "true" } })).toBe(true);
		expect(headlessResolver.resolve({ env: { WARDEN_HEADLESS: "0" } })).toBe(false);
		expect(headlessResolver.resolve({ env: {} })).toBe(false);
	});
});
