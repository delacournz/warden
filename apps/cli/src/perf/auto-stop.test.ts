import { afterEach, describe, expect, test } from "bun:test";
import { type TestContext, testContext } from "../testing";
import { runAutoStop, untilCap } from "./auto-stop";
import { createSession, readSession, stopSession } from "./session";
import { fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const T0 = 9_000_000;
const sim = { platform: "ios", id: "U1", name: "warden-iphone-17-1" } as const;

function setup(maxDurationMs: number) {
	const clock = { now: T0 };
	const c = testContext([], { now: () => clock.now });
	ctx = c;
	const deps = fakePerfDeps([sim]);
	const made = createSession(c, deps.session, {
		device: { udid: "U1", platform: "ios", name: sim.name },
		target: { udid: "U1", ownedByCaller: true },
		maxDurationMs,
	});
	if (!made.success) throw new Error("create");
	const sleeps: number[] = [];
	const sleep = async (ms: number) => {
		sleeps.push(ms);
		clock.now += ms;
	};
	return { c, clock, deps, id: made.data.id, sleeps, sleep };
}

describe("runAutoStop", () => {
	test("sleeps to the cap in ticks, then stops the session with max-duration", async () => {
		const { c, deps, id, sleeps, sleep, clock } = setup(2_500);
		expect(await runAutoStop(c, deps.session, id, { sleep })).toBe("capped");
		expect(sleeps).toEqual([1_000, 1_000, 500]);
		expect(readSession(c, id)).toMatchObject({ status: "stopped", stopReason: "max-duration", stoppedAt: clock.now });
		expect(deps.session.killed).toEqual([]);
	});

	test("returns ended when someone else stopped the session first", async () => {
		const { c, deps, id } = setup(60_000);
		stopSession(c, deps.session, id, "user");
		expect(await runAutoStop(c, deps.session, id, { sleep: async () => undefined })).toBe("ended");
	});

	test("returns missing for an unknown session", async () => {
		const { c, deps } = setup(60_000);
		expect(await runAutoStop(c, deps.session, "20000101-000000-abcdef", { sleep: async () => undefined })).toBe(
			"missing"
		);
	});

	test("an abort leaves the session running for whoever sent it", async () => {
		const { c, deps, id } = setup(60_000);
		const controller = new AbortController();
		const sleep = async () => controller.abort();
		expect(await runAutoStop(c, deps.session, id, { sleep, signal: controller.signal })).toBe("aborted");
		expect(readSession(c, id)?.status).toBe("running");
	});
});

describe("untilCap", () => {
	test("returns capped at the cap without stopping the session", async () => {
		const { c, id, sleep } = setup(5_000);
		expect(await untilCap(c, id, { sleep })).toBe("capped");
		expect(readSession(c, id)?.status).toBe("running");
	});

	test("returns missing for an unknown session", async () => {
		const { c, sleep } = setup(5_000);
		expect(await untilCap(c, "nope", { sleep })).toBe("missing");
	});

	test("returns aborted when the signal fires", async () => {
		const { c, id, sleep } = setup(60_000);
		const controller = new AbortController();
		controller.abort();
		expect(await untilCap(c, id, { sleep, signal: controller.signal })).toBe("aborted");
	});
});
