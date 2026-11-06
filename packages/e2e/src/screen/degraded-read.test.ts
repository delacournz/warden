import { describe, expect, test } from "bun:test";
import { el, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { Snapshot } from "../driver/driver.types";
import { Runtime } from "./context";
import { testHost } from "./screen.testing";

/** What `ax` shows for the error text: the label, no id. */
const lossy: Snapshot = {
	...snapshotOf([el("text", { label: "Too short" })], { backend: "ax" }),
	fellBackFrom: "axbridge",
};
const whole = snapshotOf([el("text", { id: "error", label: "Too short" })], { backend: "axbridge" });

/**
 * A device whose default reads come back from `ax` while its bridge guest is silent, then from `axbridge` once the
 * helper's background probe brought it back. Counts the explicit `axbridge` reads a look makes.
 */
function setup(screens: () => Snapshot) {
	let explicit = 0;
	const driver = fakeDriver({
		screens,
		onCall: (call) => {
			if (call.method === "snapshot" && call.opts?.backend === "axbridge") explicit += 1;
			return undefined;
		},
	});
	const host = testHost(driver, { cache: true });
	return { explicit: () => explicit, runtime: new Runtime(host), driver };
}

describe("a look that came back degraded", () => {
	test("is answered at once, with no read of its own on axbridge (the helper probes the bridge)", async () => {
		const { runtime, explicit } = setup(() => lossy);
		const result = await runtime.tryObserve({ alerts: false });
		expect(result.ok && result.observed.snapshot).toBe(lossy);
		expect(explicit()).toBe(0);
	});

	test("the next look reads the device, and gets the whole snapshot once the bridge is back", async () => {
		let bridgeBack = false;
		const { runtime, explicit } = setup(() => (bridgeBack ? whole : lossy));
		await runtime.tryObserve({ alerts: false });
		bridgeBack = true;
		const next = await runtime.tryObserve({ alerts: false });
		expect(next.ok && next.observed.snapshot).toBe(whole);
		expect(explicit()).toBe(0);
	});

	test("polling a degraded screen costs one read per look, never an extra one", async () => {
		const { runtime, driver, explicit } = setup(() => lossy);
		await runtime.tryObserve({ alerts: false });
		await runtime.tryObserve({ alerts: false });
		await runtime.tryObserve({ alerts: false });
		expect(driver.calls.filter((call) => call.method === "snapshot")).toHaveLength(3);
		expect(explicit()).toBe(0);
	});
});
