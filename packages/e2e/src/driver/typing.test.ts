import { describe, expect, test } from "bun:test";
import { failWith, fakeDriver, snapshotOf } from "./driver.testing";
import { KEY_PACE_MS, pressKeys, typeText } from "./typing";

function recorder() {
	const sleeps: number[] = [];
	return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

describe("typeText", () => {
	test("iOS: one request per grapheme, paced", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])], platform: "ios" });
		const { sleeps, sleep } = recorder();
		expect((await typeText(driver, sleep, "a@é👍🏽")).success).toBe(true);
		expect(driver.callsOf("typeText").map((call) => call.text)).toEqual(["a", "@", "é", "👍🏽"]);
		expect(sleeps).toEqual([KEY_PACE_MS, KEY_PACE_MS, KEY_PACE_MS, KEY_PACE_MS]);
	});

	test("Android: the whole string in one request", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([], { platform: "android" })], platform: "android" });
		const { sleeps, sleep } = recorder();
		await typeText(driver, sleep, "hello");
		expect(driver.callsOf("typeText")).toEqual([{ method: "typeText", text: "hello" }]);
		expect(sleeps).toEqual([]);
	});

	test("stops at the first failure and returns it", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			onCall: (call) => (call.method === "typeText" && call.text === "b" ? failWith("E_TIMEOUT") : undefined),
		});
		const { sleep } = recorder();
		const result = await typeText(driver, sleep, "abc");
		expect(result.success).toBe(false);
		expect(driver.callsOf("typeText")).toHaveLength(2);
	});
});

describe("pressKeys", () => {
	test("presses the key that many times, paced on iOS", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])], platform: "ios" });
		const { sleeps, sleep } = recorder();
		await pressKeys(driver, sleep, "Backspace", 3);
		expect(driver.callsOf("key")).toHaveLength(3);
		expect(sleeps).toEqual([KEY_PACE_MS, KEY_PACE_MS, KEY_PACE_MS]);
	});

	test("zero presses do nothing", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])] });
		const { sleep } = recorder();
		expect((await pressKeys(driver, sleep, "Backspace", 0)).success).toBe(true);
		expect(driver.calls).toEqual([]);
	});
});
