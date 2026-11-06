import { describe, expect, test } from "bun:test";
import { el, failWith, fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { Snapshot } from "../driver/driver.types";
import { Runtime } from "./context";
import { testHost } from "./screen.testing";

/** What `ax` shows for the error text: the label, no id. */
const lossy: Snapshot = {
	...snapshotOf([el("text", { label: "Too short" })], { backend: "ax" }),
	fellBackFrom: "axbridge",
};
const whole = snapshotOf([el("text", { id: "error", label: "Too short" })], { backend: "axbridge" });

type Setup = {
	bridge: "answers" | "stalls";
	probes: () => number;
	runtime: Runtime;
	clock: ReturnType<typeof testHost>["clock"];
};

/** A device whose default read is the lossy `ax` one; an explicit `axbridge` read answers or stalls. */
function setup(bridge: Setup["bridge"]): Setup {
	let probes = 0;
	const driver = fakeDriver({
		screens: [lossy],
		onCall: (call) => {
			if (call.method !== "snapshot" || call.opts?.backend !== "axbridge") return undefined;
			probes += 1;
			return bridge === "answers"
				? { data: whole }
				: failWith("E_TIMEOUT", "the axbridge guest did not answer within 4000 ms");
		},
	});
	const host = testHost(driver, { cache: true });
	return { bridge, probes: () => probes, runtime: new Runtime(host), clock: host.clock };
}

describe("a look that came back degraded", () => {
	test("is read again on axbridge, and the whole snapshot is returned", async () => {
		const { runtime, probes } = setup("answers");
		const result = await runtime.tryObserve({ alerts: false });
		expect(result.ok && result.observed.snapshot).toBe(whole);
		expect(probes()).toBe(1);
	});

	test("keeps the ax snapshot when the bridge is still silent", async () => {
		const { runtime, probes } = setup("stalls");
		const result = await runtime.tryObserve({ alerts: false });
		expect(result.ok && result.observed.snapshot.backend).toBe("ax");
		expect(probes()).toBe(1);
	});

	test("a silent bridge is not asked again until the back-off has passed", async () => {
		const { runtime, probes, clock } = setup("stalls");
		await runtime.tryObserve({ alerts: false });
		await runtime.tryObserve({ alerts: false });
		await runtime.tryObserve({ alerts: false });
		expect(probes()).toBe(1);
		await clock.sleep(6000);
		await runtime.tryObserve({ alerts: false });
		expect(probes()).toBe(2);
	});

	test("a snapshot that did not fall back costs no extra read", async () => {
		let probes = 0;
		const driver = fakeDriver({
			screens: [whole],
			onCall: (call) => {
				if (call.method === "snapshot" && call.opts?.backend === "axbridge") probes += 1;
				return undefined;
			},
		});
		await new Runtime(testHost(driver, { cache: true })).tryObserve({ alerts: false });
		expect(probes).toBe(0);
	});
});
