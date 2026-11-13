import { afterEach, describe, expect, test } from "bun:test";
import { CLAIM_ERRORS } from "@delacour/warden-core/claim-errors";
import type { Owner } from "@delacour/warden-core/types";
import { err, ok } from "@delacour/warden-types/result";
import { type LeasedDevice, type LeaseHealthDeps, RECOVERY_BACKOFF_MS, type Reading } from "./lease-health";
import { type ForwardedSignal, holdLeases } from "./lease-session";
import { type TestContext, testContext } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const owner: Owner = { kind: "ci", runId: "r1" };
const settle = async () => {
	for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(udids: string[], opts: { physical?: boolean; foreign?: boolean; env?: Record<string, string> } = {}) {
	const c = testContext([]);
	ctx = c;
	Object.assign(c.env, opts.env ?? {});
	const recorded: unknown[] = [];
	c.failure = { record: (message, extra) => recorded.push([message, extra]) };
	const ids = udids.map((id) => {
		if (!opts.foreign) c.db.recordDevice({ platform: "ios", id, name: `n-${id}`, wardenCreated: true } as never, 0);
		return c.db.insertLease(
			{
				resource: {
					kind: "device",
					platform: "ios",
					id,
					name: `n-${id}`,
					...(opts.physical ? { physical: { transport: "usb" } } : {}),
				},
				owner,
				ttlMs: 60_000,
				pid: 1,
			},
			0
		).id;
	});
	const reads: Array<Record<string, Reading>> = [];
	const sleeps: number[] = [];
	const recovers: string[] = [];
	let probing = 0;
	let maxProbing = 0;
	let recoverResults: Array<boolean> = [];
	const gate: { block?: Promise<void> } = {};
	const health: LeaseHealthDeps = {
		probe: async (_c, devices: readonly LeasedDevice[]) => {
			probing++;
			maxProbing = Math.max(maxProbing, probing);
			await gate.block;
			const next = reads.shift() ?? {};
			probing--;
			return new Map(
				devices.flatMap((d) => (next[d.resource.id] ? [[d.resource.id, next[d.resource.id] as Reading]] : []))
			);
		},
		recover: async (_c, device) => {
			recovers.push(device.resource.id);
			return recoverResults.shift() === false ? err("still dead") : ok(undefined);
		},
		sleep: async (ms) => {
			sleeps.push(ms);
		},
	};
	const ticks: Array<() => void> = [];
	const aborts: ForwardedSignal[] = [];
	const stop = holdLeases(
		c,
		{
			every: (_ms, fn) => {
				ticks.push(fn);
				return () => {};
			},
			onSignal: () => () => {},
			health,
		},
		ids,
		(s) => aborts.push(s)
	);
	const tick = async () => {
		for (const fn of ticks) fn();
		await settle();
	};
	return {
		c,
		ids,
		tick,
		aborts,
		stop,
		reads,
		sleeps,
		recovers,
		recorded,
		gate,
		maxProbing: () => maxProbing,
		failRecovers: (n: number) => {
			recoverResults = Array(n).fill(false);
		},
		events: () => c.db.listEvents().filter((e) => e.type.startsWith("device_")),
	};
}

const bad = (reason = "simctl state Shutdown"): Reading => ({ ok: false, reason });
const good: Reading = { ok: true };

describe("lease health monitor", () => {
	test("one bad read does nothing; a good read resets the count", async () => {
		const h = setup(["U1"]);
		h.reads.push({ U1: bad() }, { U1: good }, { U1: bad() });
		await h.tick();
		await h.tick();
		await h.tick();
		expect(h.recovers).toEqual([]);
		expect(h.events()).toEqual([]);
		h.stop();
	});

	test("two bad reads reboot under the same lease and log both events", async () => {
		const h = setup(["U1"]);
		h.reads.push({ U1: bad() }, { U1: bad() });
		await h.tick();
		await h.tick();
		expect(h.recovers).toEqual(["U1"]);
		expect(h.sleeps).toEqual([RECOVERY_BACKOFF_MS[0]]);
		expect(h.c.db.getLease(h.ids[0] ?? "")?.id).toBe(h.ids[0]);
		const events = h.events();
		expect(events.map((e) => e.type)).toEqual(["device_unhealthy", "device_recovered"]);
		expect(events[0]).toMatchObject({
			leaseId: h.ids[0],
			data: { deviceId: "U1", consecutive: 2, reason: "simctl state Shutdown" },
		});
		expect(events[1]).toMatchObject({ leaseId: h.ids[0], data: { deviceId: "U1", attempts: 1 } });
		expect(h.aborts).toEqual([]);
		h.stop();
	});

	test("three failed recoveries back off 5/10/20 s, record LEASE_LOST and SIGTERM once", async () => {
		const h = setup(["U1"]);
		h.failRecovers(3);
		h.reads.push({ U1: bad() }, { U1: bad() }, { U1: bad() }, { U1: bad() });
		await h.tick();
		await h.tick();
		await h.tick();
		await h.tick();
		expect(h.sleeps).toEqual([5_000, 10_000, 20_000]);
		expect(h.recovers).toHaveLength(3);
		expect(h.aborts).toEqual(["SIGTERM"]);
		expect(h.recorded).toHaveLength(1);
		expect(JSON.stringify(h.recorded)).toContain("LEASE_LOST");
		expect(JSON.stringify(h.recorded)).toContain(CLAIM_ERRORS.LEASE_LOST.hint.slice(0, 20));
		expect(h.events().map((e) => e.type)).toEqual(["device_unhealthy"]);
		h.stop();
	});

	test("a later attempt succeeding logs attempts", async () => {
		const h = setup(["U1"]);
		h.failRecovers(2);
		h.reads.push({ U1: bad() }, { U1: bad() });
		await h.tick();
		await h.tick();
		expect(h.sleeps).toEqual([5_000, 10_000, 20_000]);
		expect(h.events()[1]).toMatchObject({ type: "device_recovered", data: { attempts: 3 } });
		expect(h.aborts).toEqual([]);
		h.stop();
	});

	test("two sick devices recover one at a time", async () => {
		const h = setup(["U1", "U2"]);
		h.reads.push({ U1: bad(), U2: bad() }, { U1: bad(), U2: bad() });
		await h.tick();
		await h.tick();
		expect(h.recovers).toEqual(["U1", "U2"]);
		expect(h.events().filter((e) => e.type === "device_recovered")).toHaveLength(2);
		h.stop();
	});

	test("a physical device is reported, never rebooted, and the run goes on", async () => {
		const h = setup(["P1"], { physical: true });
		h.reads.push({ P1: bad("locked") }, { P1: bad("locked") }, { P1: bad("locked") });
		await h.tick();
		await h.tick();
		await h.tick();
		expect(h.recovers).toEqual([]);
		expect(h.events().map((e) => e.type)).toEqual(["device_unhealthy"]);
		expect(h.c.stderr.filter((l) => l.includes("not rebooting"))).toHaveLength(1);
		expect(h.aborts).toEqual([]);
		h.stop();
	});

	test("a device warden did not create is reported, not rebooted", async () => {
		const h = setup(["F1"], { foreign: true });
		h.reads.push({ F1: bad() }, { F1: bad() });
		await h.tick();
		await h.tick();
		expect(h.recovers).toEqual([]);
		expect(h.events().map((e) => e.type)).toEqual(["device_unhealthy"]);
		h.stop();
	});

	test("probes never overlap: a tick during a running probe is skipped", async () => {
		const h = setup(["U1"]);
		const release = Promise.withResolvers<void>();
		h.gate.block = release.promise;
		for (const _ of [1, 2, 3]) await h.tick();
		expect(h.maxProbing()).toBe(1);
		release.resolve();
		await settle();
		h.stop();
	});

	test("WARDEN_HEALTH_MONITOR=0 disables it", async () => {
		const h = setup(["U1"], { env: { WARDEN_HEALTH_MONITOR: "0" } });
		h.reads.push({ U1: bad() }, { U1: bad() });
		await h.tick();
		await h.tick();
		expect(h.recovers).toEqual([]);
		expect(h.events()).toEqual([]);
		expect(h.reads).toHaveLength(2);
		h.stop();
	});
});
