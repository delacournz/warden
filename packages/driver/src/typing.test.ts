import { describe, expect, test } from "bun:test";
import { resultFactory } from "@delacour/warden-types/result";
import { driverFixtures, FakeDriver } from "./driver.testing";
import { deviceTyping, type RepeatingKeys, type SelectsAll } from "./typing";

function recorder() {
	const sleeps: number[] = [];
	return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

describe("deviceTyping.typeText", () => {
	test("iOS: the whole string in one request, no client pacing (the helper paces)", async () => {
		const driver = new FakeDriver({ screens: [driverFixtures.snapshotOf([])], platform: "ios" });
		const { sleeps, sleep } = recorder();
		expect((await deviceTyping.typeText(driver, sleep, "a@é👍🏽")).success).toBe(true);
		expect(driver.callsOf("typeText").map((call) => call.text)).toEqual(["a@é👍🏽"]);
		expect(sleeps).toEqual([]);
	});

	test("Android: the whole string in one request", async () => {
		const driver = new FakeDriver({
			screens: [driverFixtures.snapshotOf([], { platform: "android" })],
			platform: "android",
		});
		const { sleeps, sleep } = recorder();
		await deviceTyping.typeText(driver, sleep, "hello");
		expect(driver.callsOf("typeText")).toEqual([{ method: "typeText", text: "hello" }]);
		expect(sleeps).toEqual([]);
	});

	test("stops at the first failure and returns it", async () => {
		const driver = new FakeDriver({
			screens: [driverFixtures.snapshotOf([])],
			onCall: (call) => (call.method === "typeText" ? driverFixtures.failWith("E_TIMEOUT") : undefined),
		});
		const { sleep } = recorder();
		const result = await deviceTyping.typeText(driver, sleep, "abc");
		expect(result.success).toBe(false);
		expect(driver.callsOf("typeText")).toHaveLength(1);
	});
});

describe("deviceTyping.pressKeys", () => {
	test("presses the key that many times, not paced by the client", async () => {
		const driver = new FakeDriver({ screens: [driverFixtures.snapshotOf([])], platform: "ios" });
		const { sleeps, sleep } = recorder();
		await deviceTyping.pressKeys(driver, sleep, "Backspace", 3);
		expect(driver.callsOf("key")).toHaveLength(3);
		expect(sleeps).toEqual([]);
	});

	test("zero presses do nothing", async () => {
		const driver = new FakeDriver({ screens: [driverFixtures.snapshotOf([])] });
		const { sleep } = recorder();
		expect((await deviceTyping.pressKeys(driver, sleep, "Backspace", 0)).success).toBe(true);
		expect(driver.calls).toEqual([]);
	});
});

describe("deviceTyping.pressKeys with a repeating driver", () => {
	test("uses the one-round-trip path for more than one press", async () => {
		const base = new FakeDriver({ screens: [driverFixtures.snapshotOf([])], platform: "android" });
		const calls: Array<[string, number]> = [];
		const driver = Object.assign(base, {
			pressKeyRepeat: async (key: string, times: number) => {
				calls.push([key, times]);
				return resultFactory.ok(undefined);
			},
		} satisfies Record<keyof RepeatingKeys, unknown>);
		const { sleeps, sleep } = recorder();
		await deviceTyping.pressKeys(driver, sleep, "Backspace", 5);
		expect(calls).toEqual([["Backspace", 5]]);
		expect(base.callsOf("key")).toHaveLength(0);
		expect(sleeps).toEqual([]);
		await deviceTyping.pressKeys(driver, sleep, "Backspace", 1);
		expect(base.callsOf("key")).toHaveLength(1);
	});
});

describe("deviceTyping.canSelectAll", () => {
	test("is true only for a driver that offers selectAll", () => {
		expect(deviceTyping.canSelectAll(new FakeDriver({ screens: [driverFixtures.snapshotOf([])] }))).toBe(false);
		expect(
			deviceTyping.canSelectAll(new FakeDriver({ screens: [driverFixtures.snapshotOf([])], selectAll: true }))
		).toBe(true);
	});

	test("selectAll is recorded as one call", async () => {
		const driver = new FakeDriver({ screens: [driverFixtures.snapshotOf([])], selectAll: true });
		if (!deviceTyping.canSelectAll(driver)) throw new Error("expected selectAll");
		expect((await driver.selectAll()).success).toBe(true);
		expect(driver.callsOf("selectAll")).toEqual([{ method: "selectAll" }]);
	});

	test("an extra method matching the capability type is enough", () => {
		const base = new FakeDriver({ screens: [driverFixtures.snapshotOf([])] });
		const driver = Object.assign(base, {
			selectAll: async () => resultFactory.ok(undefined),
		} satisfies Record<keyof SelectsAll, unknown>);
		expect(deviceTyping.canSelectAll(driver)).toBe(true);
	});
});
