import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import { CLAIM_ABORTED, type ClaimInput, claimDevices } from "./claim";
import { DEFAULT_EVENTS_DAYS, eventsRetentionMs, type LeaseEvent, type LeaseEventType } from "./lease-events";
import type { DeviceProvider } from "./providers/provider.types";
import { openStore, ownerKey, type Store } from "./store";
import type { DeviceRequest, InventoryDevice, Owner } from "./types";

let dir: string;
let store: Store;
const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/w" };
const other: Owner = { kind: "agent", sessionId: "s2", cwd: "/x" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-events-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function sim(id: string, state: InventoryDevice["state"] = "booted"): InventoryDevice {
	return {
		platform: "ios",
		id,
		name: `warden-iphone-17-${id}`,
		state,
		wardenCreated: false,
		runtime: "iOS-26-5",
	};
}

function provider(devices: InventoryDevice[], bootFails = false): DeviceProvider {
	return {
		platform: "ios",
		inventory: async () => ok(devices.map((d) => ({ ...d }))),
		create: async () => {
			throw new Error("no create");
		},
		boot: async (id) => {
			if (bootFails) return { success: false, error: `boot ${id} failed` };
			return ok(undefined);
		},
		waitReady: async () => ok(undefined),
		shutdown: async () => ok(undefined),
	};
}

const request = (overrides: Partial<DeviceRequest> = {}): DeviceRequest => ({
	platform: "ios",
	profile: "iphone-17",
	count: 1,
	max: 2,
	...overrides,
});

function claimInput(p: DeviceProvider, clock: { at: number }, overrides: Partial<ClaimInput> = {}): ClaimInput {
	return {
		store,
		provider: p,
		owner,
		request: request(),
		ttlMs: 60_000,
		now: () => clock.at,
		pidAlive: () => false,
		waitMs: 0,
		sleep: async () => {},
		...overrides,
	};
}

const types = (events: LeaseEvent[]): LeaseEventType[] => events.map((e) => e.type);

describe("lease events", () => {
	test("claim then release logs requested, granted, released with the same lease id", async () => {
		const clock = { at: 1_000 };
		const result = await claimDevices(claimInput(provider([sim("1")]), clock, { label: "e2e" }));
		expect(result.success).toBe(true);
		const leaseId = result.success ? (result.data.claimed[0]?.lease.id ?? "") : "";
		clock.at = 5_000;
		store.deleteLeases([leaseId], { type: "released", now: clock.at });
		const events = store.listEvents();
		expect(types(events)).toEqual(["requested", "granted", "released"]);
		const [requested, granted, released] = events;
		expect(requested).toMatchObject({ ownerKey: ownerKey(owner), label: "e2e", data: { platform: "ios", count: 1 } });
		expect(granted).toMatchObject({
			leaseId,
			label: "e2e",
			resourceKey: "device:ios:1",
			data: { action: "reuse", deviceId: "1", profile: "iphone-17", waitMs: 0 },
		});
		expect(released).toMatchObject({ leaseId, at: 5_000, data: { heldMs: 4_000 } });
		expect(new Set(events.map((e) => e.claimId)).size).toBe(1);
	});

	test("a rolled-back claim logs requested only: no grant, no release", async () => {
		const clock = { at: 1_000 };
		const result = await claimDevices(claimInput(provider([sim("1", "shutdown")], true), clock));
		expect(result.success).toBe(false);
		expect(types(store.listEvents())).toEqual(["requested"]);
	});

	test("deleting a lease that was never granted logs nothing", () => {
		const lease = store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "9", name: "n" }, owner, ttlMs: 1 },
			0
		);
		store.deleteLeases([lease.id], { type: "released", now: 1 });
		expect(store.listEvents()).toEqual([]);
	});

	test("a stale lease reclaimed by the next claim logs expired against the old lease id", async () => {
		const clock = { at: 0 };
		const p = provider([sim("1")]);
		const first = await claimDevices(claimInput(p, clock, { ttlMs: 1, request: request({ max: 1 }) }));
		const oldId = first.success ? (first.data.claimed[0]?.lease.id ?? "") : "";
		clock.at = 10_000;
		const second = await claimDevices(claimInput(p, clock, { owner: other, request: request({ max: 1 }) }));
		expect(second.success).toBe(true);
		const expired = store.listEvents({ leaseId: oldId }).find((e) => e.type === "expired");
		expect(expired).toMatchObject({ at: 10_000, ownerKey: ownerKey(owner), data: { heldMs: 10_000 } });
	});

	test("granted carries the wait since the claim was requested", async () => {
		const clock = { at: 0 };
		const blocker = store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "1", name: "warden-iphone-17-1" }, owner: other, ttlMs: 1e9 },
			0
		);
		const p = provider([sim("1")]);
		const result = await claimDevices(
			claimInput(p, clock, {
				request: request({ max: 1 }),
				waitMs: 60_000,
				pidAlive: () => true,
				sleep: async () => {
					clock.at += 2_000;
					store.deleteLeases([blocker.id]);
				},
			})
		);
		expect(result.success).toBe(true);
		const granted = store.listEvents().find((e) => e.type === "granted");
		expect(granted?.data).toMatchObject({ waitMs: 2_000 });
	});

	test("a claim that waits for a device logs queued once, with the reason", async () => {
		const clock = { at: 0 };
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "1", name: "warden-iphone-17-1" }, owner: other, ttlMs: 1e9 },
			0
		);
		let polls = 0;
		const p = provider([sim("1")]);
		const result = await claimDevices(
			claimInput(p, clock, {
				request: request({ max: 1 }),
				waitMs: 60_000,
				pidAlive: () => true,
				abort: () => polls >= 3,
				sleep: async () => void polls++,
				capacity: {
					budget: { memMb: 1e9, cpu: 100, maxUnits: Number.POSITIVE_INFINITY },
					config: {},
					hostInventory: async () => ok([sim("1")]),
				},
			})
		);
		expect(result).toEqual({ success: false, error: CLAIM_ABORTED });
		const queued = store.listEvents().filter((e) => e.type === "queued");
		expect(queued).toHaveLength(1);
		expect(queued[0]?.data).toMatchObject({ reason: "device-limit", platform: "ios" });
	});

	test("quarantine and unquarantine are logged with the change", () => {
		const dev = { platform: "ios" as const, id: "U1", name: "warden-iphone-17-1" };
		store.quarantineDevice(dev, "hung", 5);
		expect(store.unquarantineDevice("U1", 6)).toBe(1);
		expect(store.unquarantineDevice("U1", 7)).toBe(0);
		const events = store.listEvents();
		expect(types(events)).toEqual(["quarantined", "unquarantined"]);
		expect(events[0]).toMatchObject({ at: 5, resourceKey: "device:ios:U1", data: { reason: "hung", deviceId: "U1" } });
		expect(events[1]).toMatchObject({ at: 6, data: { deviceId: "U1" } });
	});

	test("heartbeat_lost is logged for leases no longer held, copying who held them", async () => {
		const clock = { at: 1_000 };
		const result = await claimDevices(claimInput(provider([sim("1")]), clock));
		const lease = result.success ? result.data.claimed[0]?.lease : undefined;
		expect(store.recordHeartbeatLost([lease?.id ?? ""], 2_000)).toBe(0);
		store.deleteLeases([lease?.id ?? ""]);
		expect(store.recordHeartbeatLost([lease?.id ?? ""], 2_000)).toBe(1);
		const lost = store.listEvents().find((e) => e.type === "heartbeat_lost");
		expect(lost).toMatchObject({ leaseId: lease?.id, ownerKey: ownerKey(owner), resourceKey: "device:ios:1" });
	});

	test("events are filtered by since, lease, owner substring and cursor; pruned by age", () => {
		const e = (at: number, leaseId: string, ownerKey: string) =>
			store.recordEvent({ at, type: "released", data: { heldMs: 1 }, leaseId, ownerKey });
		e(100, "l_a", "agent:alpha");
		e(200, "l_b", "agent:beta");
		e(300, "l_a", "user:42");
		expect(store.listEvents({ since: 200 }).map((x) => x.at)).toEqual([200, 300]);
		expect(store.listEvents({ leaseId: "l_a" }).map((x) => x.at)).toEqual([100, 300]);
		expect(store.listEvents({ owner: "beta" }).map((x) => x.leaseId)).toEqual(["l_b"]);
		expect(store.listEvents({ owner: "agent:" })).toHaveLength(2);
		const first = store.listEvents()[0];
		expect(store.listEvents({ afterId: first?.id ?? 0 })).toHaveLength(2);
		expect(store.pruneEvents(250)).toBe(2);
		expect(store.listEvents().map((x) => x.at)).toEqual([300]);
	});

	test("retention is WARDEN_EVENTS_DAYS, default 7, positive integers only", () => {
		expect(eventsRetentionMs({})).toEqual({ success: true, data: DEFAULT_EVENTS_DAYS * 86_400_000 });
		expect(eventsRetentionMs({ WARDEN_EVENTS_DAYS: "2" })).toEqual({ success: true, data: 2 * 86_400_000 });
		for (const bad of ["0", "-1", "1.5", "abc"]) {
			expect(eventsRetentionMs({ WARDEN_EVENTS_DAYS: bad }).success).toBe(false);
		}
	});
});
