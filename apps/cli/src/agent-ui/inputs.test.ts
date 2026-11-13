import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "@delacour/warden-e2e/driver/driver.testing";
import { watchInputs } from "./inputs";

describe("watchInputs", () => {
	const screen = snapshotOf([el("button", { label: "Go" })]);

	test("taps, typing, swipes, keys and app launches count; reads, settle and close do not", async () => {
		let inputs = 0;
		const driver = watchInputs(fakeDriver({ screens: [screen] }), () => {
			inputs += 1;
		});
		await driver.snapshot();
		await driver.elementAtPoint({ x: 1, y: 1 });
		await driver.health();
		await driver.settle({ quietMs: 100, timeoutMs: 200 });
		await driver.app.isInstalled("x");
		expect(inputs).toBe(0);
		await driver.tap({ x: 1, y: 1 });
		await driver.typeText("hi");
		await driver.swipe({ x: 1, y: 1 }, { x: 1, y: 100 });
		await driver.app.launch("x");
		expect(inputs).toBe(4);
		await driver.close();
		expect(inputs).toBe(4);
	});

	test("the input is counted before the call, so one that fails still counts", async () => {
		let inputs = 0;
		const driver = watchInputs(
			fakeDriver({
				screens: [screen],
				onCall: (call) =>
					call.method === "tap" ? { error: { code: "E_HID", message: "boom", retryable: false } } : undefined,
			}),
			() => {
				inputs += 1;
			}
		);
		const tapped = await driver.tap({ x: 1, y: 1 });
		expect(tapped.success).toBe(false);
		expect(inputs).toBe(1);
	});

	test("the wrapped driver keeps its identity-free members (platform, capabilities)", () => {
		const inner = fakeDriver({ screens: [screen], capabilities: { cheapHitTest: true } });
		const driver = watchInputs(inner, () => undefined);
		expect(driver.platform).toBe(inner.platform);
		expect(driver.capabilities.cheapHitTest).toBe(true);
	});
});
