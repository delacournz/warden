import { describe, expect, test } from "bun:test";
import { ok } from "@delacour/warden-types/result";
import { failWith, fakeDriver, snapshotOf } from "./driver.testing";
import { canSelectAll, canTypeQuickly, pressKeys, type RepeatingKeys, type SelectsAll, typeText } from "./typing";

function recorder() {
	const sleeps: number[] = [];
	return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

describe("typeText", () => {
	test("iOS: the whole string in one request, no client pacing (the helper paces)", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])], platform: "ios" });
		const { sleeps, sleep } = recorder();
		expect((await typeText(driver, sleep, "a@é👍🏽")).success).toBe(true);
		expect(driver.callsOf("typeText").map((call) => call.text)).toEqual(["a@é👍🏽"]);
		expect(sleeps).toEqual([]);
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
			onCall: (call) => (call.method === "typeText" ? failWith("E_TIMEOUT") : undefined),
		});
		const { sleep } = recorder();
		const result = await typeText(driver, sleep, "abc");
		expect(result.success).toBe(false);
		expect(driver.callsOf("typeText")).toHaveLength(1);
	});
});

describe("typeText quick", () => {
	test("a driver that types quickly gets the text in one typeTextQuick call", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])], platform: "ios", typeTextQuick: true });
		const { sleeps, sleep } = recorder();
		expect((await typeText(driver, sleep, "ada@example.com", "quick")).success).toBe(true);
		expect(driver.callsOf("typeTextQuick")).toEqual([{ method: "typeTextQuick", text: "ada@example.com" }]);
		expect(driver.callsOf("typeText")).toEqual([]);
		expect(sleeps).toEqual([]);
	});

	test("paced (the default) never types quickly, even where the driver can", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])], platform: "ios", typeTextQuick: true });
		const { sleep } = recorder();
		await typeText(driver, sleep, "abc");
		await typeText(driver, sleep, "def", "paced");
		expect(driver.callsOf("typeTextQuick")).toEqual([]);
		expect(driver.callsOf("typeText").map((call) => call.text)).toEqual(["abc", "def"]);
	});

	test("quick on a driver without the capability (Android) types as usual", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([], { platform: "android" })], platform: "android" });
		const { sleep } = recorder();
		await typeText(driver, sleep, "hello", "quick");
		expect(driver.callsOf("typeText")).toEqual([{ method: "typeText", text: "hello" }]);
	});

	test("a failed quick call is returned, not retried paced (the read-back decides)", async () => {
		const driver = fakeDriver({
			screens: [snapshotOf([])],
			typeTextQuick: true,
			onCall: (call) => (call.method === "typeTextQuick" ? failWith("E_TIMEOUT") : undefined),
		});
		const { sleep } = recorder();
		expect((await typeText(driver, sleep, "abc", "quick")).success).toBe(false);
		expect(driver.callsOf("typeText")).toEqual([]);
	});

	test("canTypeQuickly is true only for a driver that offers typeTextQuick", () => {
		expect(canTypeQuickly(fakeDriver({ screens: [snapshotOf([])] }))).toBe(false);
		expect(canTypeQuickly(fakeDriver({ screens: [snapshotOf([])], typeTextQuick: true }))).toBe(true);
	});
});

describe("pressKeys", () => {
	test("presses the key that many times, not paced by the client", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])], platform: "ios" });
		const { sleeps, sleep } = recorder();
		await pressKeys(driver, sleep, "Backspace", 3);
		expect(driver.callsOf("key")).toHaveLength(3);
		expect(sleeps).toEqual([]);
	});

	test("zero presses do nothing", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])] });
		const { sleep } = recorder();
		expect((await pressKeys(driver, sleep, "Backspace", 0)).success).toBe(true);
		expect(driver.calls).toEqual([]);
	});
});

describe("pressKeys with a repeating driver", () => {
	test("uses the one-round-trip path for more than one press", async () => {
		const base = fakeDriver({ screens: [snapshotOf([])], platform: "android" });
		const calls: Array<[string, number]> = [];
		const driver = Object.assign(base, {
			pressKeyRepeat: async (key: string, times: number) => {
				calls.push([key, times]);
				return ok(undefined);
			},
		} satisfies Record<keyof RepeatingKeys, unknown>);
		const { sleeps, sleep } = recorder();
		await pressKeys(driver, sleep, "Backspace", 5);
		expect(calls).toEqual([["Backspace", 5]]);
		expect(base.callsOf("key")).toHaveLength(0);
		expect(sleeps).toEqual([]);
		await pressKeys(driver, sleep, "Backspace", 1);
		expect(base.callsOf("key")).toHaveLength(1);
	});
});

describe("canSelectAll", () => {
	test("is true only for a driver that offers selectAll", () => {
		expect(canSelectAll(fakeDriver({ screens: [snapshotOf([])] }))).toBe(false);
		expect(canSelectAll(fakeDriver({ screens: [snapshotOf([])], selectAll: true }))).toBe(true);
	});

	test("selectAll is recorded as one call", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([])], selectAll: true });
		if (!canSelectAll(driver)) throw new Error("expected selectAll");
		expect((await driver.selectAll()).success).toBe(true);
		expect(driver.callsOf("selectAll")).toEqual([{ method: "selectAll" }]);
	});

	test("an extra method matching the capability type is enough", () => {
		const base = fakeDriver({ screens: [snapshotOf([])] });
		const driver = Object.assign(base, {
			selectAll: async () => ok(undefined),
		} satisfies Record<keyof SelectsAll, unknown>);
		expect(canSelectAll(driver)).toBe(true);
	});
});
