import { afterEach, describe, expect, test } from "bun:test";
import type { Owner } from "@delacour/warden-core/types";
import { OWNER_ENV } from "../simctl.testing";
import { type TestContext, testContext } from "../testing";
import { type BootedDevice, PERF_LEASE_LABEL, type PerfDeviceDeps, resolvePerfDevice } from "./device";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const other: Owner = { kind: "agent", sessionId: "other", cwd: "/" };

function setup(booted: BootedDevice[], apps: Record<string, string> = {}): { c: TestContext; deps: PerfDeviceDeps } {
	const c = testContext([]);
	ctx = c;
	c.env = { ...c.env, ...OWNER_ENV };
	const deps: PerfDeviceDeps = {
		pidAlive: () => false,
		booted: async () => booted,
		foregroundApp: async (_ctx, device) => apps[device.id],
	};
	return { c, deps };
}

const sim = (n: number): BootedDevice => ({ platform: "ios", id: `U${n}`, name: `warden-iphone-17-${n}` });

function record(c: TestContext, device: BootedDevice): void {
	c.db.recordDevice({ platform: device.platform, id: device.id, name: device.name }, c.now());
}

function lease(c: TestContext, device: BootedDevice, owner: Owner, extra: { pid?: number; label?: string } = {}) {
	return c.db.insertLease(
		{
			resource: { kind: "device", platform: device.platform, id: device.id, name: device.name },
			owner,
			ttlMs: 60_000,
			...extra,
		},
		c.now()
	);
}

describe("resolvePerfDevice: observe", () => {
	test("an unleased warden device is usable and no lease is taken", async () => {
		const { c, deps } = setup([sim(1)]);
		record(c, sim(1));
		const r = await resolvePerfDevice(c, {}, "observe", deps);
		expect(r).toMatchObject({ success: true, data: { udid: "U1", platform: "ios", ownedByCaller: false } });
		expect(c.db.listLeases()).toEqual([]);
	});

	test("a device under a foreign lease is observable: holder reported, lease untouched", async () => {
		const { c, deps } = setup([sim(1)]);
		record(c, sim(1));
		const held = lease(c, sim(1), other);
		c.now = () => 1_030_000;
		const r = await resolvePerfDevice(c, { udid: "U1" }, "observe", deps);
		expect(r.success).toBe(true);
		if (!r.success) return;
		expect(r.data.ownedByCaller).toBe(false);
		expect(r.data.holder).toContain("other");
		expect(c.db.getLease(held.id)?.heartbeatAt).toBe(held.heartbeatAt);
	});

	test("the caller's own lease is ownedByCaller and not heartbeated by observing", async () => {
		const { c, deps } = setup([sim(1)]);
		const own = lease(c, sim(1), { kind: "agent", sessionId: "me", cwd: "/" });
		c.now = () => 1_030_000;
		const r = await resolvePerfDevice(c, {}, "observe", deps);
		expect(r).toMatchObject({ success: true, data: { udid: "U1", ownedByCaller: true, source: "lease" } });
		expect(c.db.getLease(own.id)?.heartbeatAt).toBe(own.heartbeatAt);
	});

	test("a device warden does not know is refused as device_unknown", async () => {
		const { c, deps } = setup([sim(1)]);
		const r = await resolvePerfDevice(c, { udid: "FOREIGN-UDID" }, "observe", deps);
		expect(r).toMatchObject({ success: false, error: { code: "device_unknown" } });
		const env = await resolvePerfDevice({ ...c, env: { ...c.env, WARDEN_UDID: "NOPE" } }, {}, "observe", deps);
		expect(env).toMatchObject({ success: false, error: { code: "device_unknown" } });
	});

	test("with several booted warden devices it is ambiguous and lists them with holder and app", async () => {
		const { c, deps } = setup([sim(1), sim(2)], { U1: "com.acme.shop" });
		record(c, sim(1));
		record(c, sim(2));
		lease(c, sim(2), other, { label: "e2e" });
		const r = await resolvePerfDevice(c, {}, "observe", deps);
		expect(r.success).toBe(false);
		if (r.success) return;
		expect(r.error.code).toBe("ambiguous_device");
		const candidates = r.error.details?.candidates;
		expect(candidates).toEqual([
			{ udid: "U1", platform: "ios", name: "warden-iphone-17-1", app: "com.acme.shop" },
			{ udid: "U2", platform: "ios", name: "warden-iphone-17-2", holder: expect.stringContaining("other") },
		]);
	});

	test("the caller's single lease wins over other booted warden devices", async () => {
		const { c, deps } = setup([sim(1), sim(2)]);
		record(c, sim(1));
		record(c, sim(2));
		lease(c, sim(2), { kind: "agent", sessionId: "me", cwd: "/" });
		const r = await resolvePerfDevice(c, {}, "observe", deps);
		expect(r).toMatchObject({ success: true, data: { udid: "U2" } });
	});

	test("shut-down devices are not candidates; none booted is no_device_leased", async () => {
		const { c, deps } = setup([]);
		record(c, sim(1));
		const r = await resolvePerfDevice(c, {}, "observe", deps);
		expect(r).toMatchObject({ success: false, error: { code: "no_device_leased" } });
	});

	test("--platform narrows the candidates", async () => {
		const android: BootedDevice = { platform: "android", id: "emulator-5554", name: "Pixel" };
		const { c, deps } = setup([sim(1), android]);
		record(c, sim(1));
		record(c, android);
		const r = await resolvePerfDevice(c, { platform: "android" }, "observe", deps);
		expect(r).toMatchObject({ success: true, data: { udid: "emulator-5554", platform: "android" } });
	});
});

describe("resolvePerfDevice: mutate", () => {
	test("a foreign live lease refuses with device_foreign and the --claim / --allow-mutate-foreign hint", async () => {
		const { c, deps } = setup([sim(1)]);
		record(c, sim(1));
		lease(c, sim(1), other);
		const r = await resolvePerfDevice(c, { udid: "U1" }, "mutate", deps);
		expect(r.success).toBe(false);
		if (r.success) return;
		expect(r.error.code).toBe("device_foreign");
		expect(r.error.hint).toContain("--claim");
		expect(r.error.hint).toContain("--allow-mutate-foreign");
	});

	test("--allow-mutate-foreign passes a foreign lease nobody is running a process on", async () => {
		const { c, deps } = setup([sim(1)]);
		record(c, sim(1));
		lease(c, sim(1), other);
		const r = await resolvePerfDevice(c, { udid: "U1", allowMutateForeign: true }, "mutate", deps);
		expect(r).toMatchObject({ success: true, data: { udid: "U1", ownedByCaller: false } });
	});

	test("--allow-mutate-foreign is refused while a live warden process holds the lease", async () => {
		const { c, deps } = setup([sim(1)]);
		record(c, sim(1));
		lease(c, sim(1), other, { pid: 4321 });
		const live: PerfDeviceDeps = { ...deps, pidAlive: (pid) => pid === 4321 };
		const r = await resolvePerfDevice(c, { udid: "U1", allowMutateForeign: true }, "mutate", live);
		expect(r).toMatchObject({ success: false, error: { code: "device_busy" } });
	});

	test("an unleased device needs --claim; the claim leases it as warden perf", async () => {
		const { c, deps } = setup([sim(1)]);
		record(c, sim(1));
		const refused = await resolvePerfDevice(c, { udid: "U1" }, "mutate", deps);
		expect(refused).toMatchObject({ success: false, error: { code: "device_not_leased" } });
		const claimed = await resolvePerfDevice(c, { udid: "U1", claim: true }, "mutate", deps);
		expect(claimed).toMatchObject({ success: true, data: { udid: "U1", ownedByCaller: true } });
		expect(c.db.listLeases()).toHaveLength(1);
		expect(c.db.listLeases()[0]?.label).toBe(PERF_LEASE_LABEL);
	});

	test("the caller's own lease is heartbeated", async () => {
		const { c, deps } = setup([sim(1)]);
		const own = lease(c, sim(1), { kind: "agent", sessionId: "me", cwd: "/" });
		c.now = () => 1_020_000;
		const r = await resolvePerfDevice(c, {}, "mutate", deps);
		expect(r).toMatchObject({ success: true, data: { ownedByCaller: true } });
		expect(c.db.getLease(own.id)?.heartbeatAt).toBe(1_020_000);
	});
});
