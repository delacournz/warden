import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type ClaimInput, claimDevices, PENDING_PREFIX } from "./claim";
import type { DeviceProvider } from "./providers/provider.types";
import { openStore, type Store } from "./store";
import type { DeviceRequest, InventoryDevice, Owner } from "./types";

let dir: string;
let store: Store;
const NOW = 1_000_000;
const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/w" };
const other: Owner = { kind: "agent", sessionId: "s2", cwd: "/x" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-claim-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function sim(id: string, overrides: Partial<InventoryDevice> = {}): InventoryDevice {
	return {
		platform: "ios",
		id,
		name: `warden-iphone-17-${id}`,
		state: "shutdown",
		wardenCreated: false,
		runtime: "iOS-26-5",
		...overrides,
	};
}

type FakeProvider = DeviceProvider & { devices: InventoryDevice[]; calls: string[] };

function fakeProvider(devices: InventoryDevice[], failures: { boot?: string; create?: string } = {}): FakeProvider {
	const calls: string[] = [];
	let created = 0;
	const p: FakeProvider = {
		platform: "ios",
		devices,
		calls,
		inventory: async () => ok(p.devices.map((d) => ({ ...d }))),
		async create(name, profile, runtime): AsyncResult<InventoryDevice> {
			calls.push(`create ${name} ${profile} ${runtime ?? "-"}`);
			if (failures.create) return err(failures.create);
			created++;
			const device: InventoryDevice = {
				platform: "ios",
				id: `NEW${created}`,
				name,
				state: "shutdown",
				wardenCreated: true,
				profile,
				runtime: "iOS-26-5",
			};
			p.devices.push(device);
			store.recordDevice({ platform: "ios", id: device.id, name, profile }, NOW);
			return ok(device);
		},
		async boot(id) {
			calls.push(`boot ${id}`);
			if (failures.boot === id) return err(`boot ${id} failed`);
			const d = p.devices.find((x) => x.id === id);
			if (d) d.state = "booted";
			return ok(undefined);
		},
		async waitReady(id) {
			calls.push(`ready ${id}`);
			return ok(undefined);
		},
		async shutdown(id) {
			calls.push(`shutdown ${id}`);
			return ok(undefined);
		},
	};
	return p;
}

function request(overrides: Partial<DeviceRequest> = {}): DeviceRequest {
	return { platform: "ios", profile: "iphone-17", count: 1, max: 2, ...overrides };
}

function input(provider: DeviceProvider, overrides: Partial<ClaimInput> = {}): ClaimInput {
	return {
		store,
		provider,
		owner,
		request: request(),
		ttlMs: 60_000,
		now: () => NOW,
		pidAlive: () => false,
		waitMs: 0,
		sleep: async () => {},
		...overrides,
	};
}

describe("claimDevices", () => {
	test("reuses a booted free warden device without booting", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		const result = await claimDevices(input(provider, { label: "e2e" }));
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.claimed).toHaveLength(1);
		const [c] = result.data.claimed;
		expect(c?.action).toBe("reuse");
		expect(c?.device.id).toBe("1");
		expect(c?.lease.label).toBe("e2e");
		expect(provider.calls).toEqual(["ready 1"]);
		expect(store.listLeases().map((l) => l.id)).toEqual([c?.lease.id ?? ""]);
		expect(store.listLeases()[0]?.bootedByOwner).toBeUndefined();
	});

	test("boots a shutdown warden device", async () => {
		const provider = fakeProvider([sim("1")]);
		const result = await claimDevices(input(provider));
		expect(result.success && result.data.claimed[0]?.action).toBe("boot");
		expect(provider.calls).toEqual(["boot 1", "ready 1"]);
		expect(result.success && result.data.claimed[0]?.device.state).toBe("booted");
		expect(store.listLeases()[0]?.bootedByOwner).toBe(true);
		expect(result.success && result.data.claimed[0]?.lease.bootedByOwner).toBe(true);
	});

	test("boots every claimed device at once, not one by one", async () => {
		const provider = fakeProvider([sim("1"), sim("2"), sim("3")]);
		let inFlight = 0;
		let peak = 0;
		const boot = provider.boot;
		provider.boot = async (id) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await Bun.sleep(5);
			inFlight--;
			return boot(id);
		};
		const result = await claimDevices(input(provider, { request: request({ count: 3, max: 3 }) }));
		expect(result.success).toBe(true);
		expect(peak).toBe(3);
	});

	test("creates when pool has room; lease is on the real udid, not the placeholder", async () => {
		const provider = fakeProvider([]);
		const result = await claimDevices(input(provider, { request: request({ runtime: "latest" }) }));
		expect(result.success).toBe(true);
		if (!result.success) return;
		expect(result.data.claimed[0]?.action).toBe("create");
		expect(provider.calls).toEqual(["create warden-iphone-17-1 iphone-17 latest", "boot NEW1", "ready NEW1"]);
		const leases = store.listLeases();
		expect(leases).toHaveLength(1);
		expect(leases[0]?.resource).toEqual({ kind: "device", platform: "ios", id: "NEW1", name: "warden-iphone-17-1" });
		expect(leases[0]?.bootedByOwner).toBe(true);
	});

	test("never hands out a device leased by someone else", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" }), sim("2", { state: "booted" })]);
		const first = await claimDevices(input(provider, { owner: other }));
		const second = await claimDevices(input(provider));
		expect(first.success && second.success).toBe(true);
		if (!first.success || !second.success) return;
		expect(first.data.claimed[0]?.device.id).not.toBe(second.data.claimed[0]?.device.id);
	});

	test("foreign devices are skipped unless adopt", async () => {
		const foreign = sim("F", { name: "iPhone 17", profile: "iphone-17", state: "booted" });
		const provider = fakeProvider([foreign]);
		const noAdopt = await claimDevices(input(provider, { request: request({ max: 0 }) }));
		expect(noAdopt.success).toBe(false);
		const adopt = await claimDevices(input(provider, { request: request({ max: 0, adopt: true }) }));
		expect(adopt.success && adopt.data.claimed[0]?.device.id).toBe("F");
	});

	test("pool full + no wait → clear err", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" }), sim("2", { state: "booted" })]);
		await claimDevices(input(provider, { owner: other, request: request({ count: 2 }) }));
		const result = await claimDevices(input(provider));
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error).toBe("all 2 warden-iphone-17 devices leased; max 2 — use --wait or --max");
		}
	});

	test("waits (polling) until a lease is released", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		const held = await claimDevices(input(provider, { owner: other, request: request({ max: 1 }) }));
		expect(held.success).toBe(true);
		let clock = NOW;
		const sleeps: number[] = [];
		const result = await claimDevices(
			input(provider, {
				request: request({ max: 1 }),
				now: () => clock,
				waitMs: 10_000,
				pollMs: 1_000,
				sleep: async (ms) => {
					sleeps.push(ms);
					clock += ms;
					if (sleeps.length === 3 && held.success) store.deleteLeases(held.data.claimed.map((c) => c.lease.id));
				},
			})
		);
		expect(result.success).toBe(true);
		expect(sleeps).toEqual([1_000, 1_000, 1_000]);
	});

	test("wait gives up after waitMs", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		await claimDevices(input(provider, { owner: other, request: request({ max: 1 }) }));
		let clock = NOW;
		const result = await claimDevices(
			input(provider, {
				request: request({ max: 1 }),
				now: () => clock,
				waitMs: 3_000,
				pollMs: 1_000,
				sleep: async (ms) => {
					clock += ms;
				},
			})
		);
		expect(result.success).toBe(false);
		expect(clock).toBe(NOW + 3_000);
	});

	test("stale leases are reclaimed", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "1", name: "warden-iphone-17-1" }, owner: other, ttlMs: 1 },
			0
		);
		const result = await claimDevices(input(provider, { request: request({ max: 1 }) }));
		expect(result.success).toBe(true);
		if (result.success) expect(result.data.reclaimed).toHaveLength(1);
	});

	test("boot failure → all leases from this claim released, err returned", async () => {
		const provider = fakeProvider([sim("1"), sim("2")], { boot: "2" });
		const result = await claimDevices(input(provider, { request: request({ count: 2 }) }));
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("boot 2 failed");
		expect(store.listLeases()).toEqual([]);
	});

	test("create failure → placeholder removed", async () => {
		const provider = fakeProvider([], { create: "no runtime" });
		const result = await claimDevices(input(provider));
		expect(result.success).toBe(false);
		expect(store.listLeases()).toEqual([]);
	});

	test("in-flight create (placeholder) blocks the name and counts toward max", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		store.insertLease(
			{
				resource: {
					kind: "device",
					platform: "ios",
					id: `${PENDING_PREFIX}warden-iphone-17-2`,
					name: "warden-iphone-17-2",
				},
				owner: other,
				ttlMs: 60_000,
			},
			NOW
		);
		provider.devices.push(sim("2", { name: "warden-iphone-17-2" }));
		const held = await claimDevices(input(provider, { owner: other }));
		expect(held.success && held.data.claimed[0]?.device.id).toBe("1");
		const result = await claimDevices(input(provider));
		expect(result.success).toBe(false);
		expect(provider.calls.filter((c) => c.startsWith("create"))).toEqual([]);
	});

	test("touches devices on success and sets lease pid", async () => {
		const provider = fakeProvider([sim("1", { state: "booted" })]);
		store.recordDevice({ platform: "ios", id: "1", name: "warden-iphone-17-1", profile: "iphone-17" }, 5);
		const result = await claimDevices(input(provider, { pid: 4242 }));
		expect(result.success && result.data.claimed[0]?.lease.pid).toBe(4242);
		expect(store.listDevices("ios")[0]?.lastUsedAt).toBe(NOW);
	});

	test("heartbeat refreshed once devices are ready (boot can be slow)", async () => {
		let clock = NOW;
		const provider = fakeProvider([sim("1")]);
		const boot = provider.boot.bind(provider);
		provider.boot = async (id) => {
			clock += 120_000;
			return boot(id);
		};
		const result = await claimDevices(input(provider, { now: () => clock }));
		expect(result.success && result.data.claimed[0]?.lease.heartbeatAt).toBe(NOW + 120_000);
		expect(store.listLeases()[0]?.heartbeatAt).toBe(NOW + 120_000);
	});

	test("inventory failure → err", async () => {
		const provider = fakeProvider([]);
		provider.inventory = async () => err("simctl missing");
		const result = await claimDevices(input(provider));
		expect(result).toEqual({ success: false, error: "simctl missing" });
	});
});
