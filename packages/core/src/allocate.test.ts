import { describe, expect, test } from "bun:test";
import { allocate, defaultMax, profileSlug, wardenDeviceName } from "./allocate";
import type { DeviceRequest, InventoryDevice, Lease } from "./types";

const NOW = 1_000_000;

function sim(overrides: Partial<InventoryDevice> & { id: string }): InventoryDevice {
	return {
		platform: "ios",
		name: `warden-iphone-17-${overrides.id}`,
		state: "shutdown",
		wardenCreated: true,
		profile: "iphone-17",
		runtime: "iOS-26-5",
		...overrides,
	};
}

function lease(deviceId: string, overrides: Partial<Lease> = {}): Lease {
	return {
		id: `lease-${deviceId}`,
		resource: { kind: "device", platform: "ios", id: deviceId, name: deviceId },
		owner: { kind: "agent", sessionId: "s1", cwd: "/" },
		acquiredAt: NOW - 1_000,
		heartbeatAt: NOW - 1_000,
		ttlMs: 60_000,
		...overrides,
	};
}

const req: DeviceRequest = { platform: "ios", profile: "iphone-17", count: 1, max: 4 };
const noPid = () => false;

describe("allocate", () => {
	test("reuses a free booted warden device before booting a shutdown one", () => {
		const plan = allocate({
			inventory: [sim({ id: "1" }), sim({ id: "2", state: "booted" })],
			leases: [],
			request: req,
			now: NOW,
			pidAlive: noPid,
		});
		expect(plan).toEqual({
			kind: "assign",
			steps: [{ action: "reuse", device: sim({ id: "2", state: "booted" }) }],
			stale: [],
		});
	});

	test("boots a free shutdown warden device", () => {
		const plan = allocate({ inventory: [sim({ id: "1" })], leases: [], request: req, now: NOW, pidAlive: noPid });
		expect(plan.kind === "assign" && plan.steps[0]?.action).toBe("boot");
	});

	test("skips leased devices", () => {
		const plan = allocate({
			inventory: [sim({ id: "1", state: "booted" }), sim({ id: "2" })],
			leases: [lease("1")],
			request: req,
			now: NOW,
			pidAlive: noPid,
		});
		expect(plan.kind === "assign" && plan.steps.map((s) => s.action)).toEqual(["boot"]);
	});

	test("skips foreign booted devices unless adopt", () => {
		const foreign = sim({ id: "f", name: "iPhone 17", state: "booted", wardenCreated: false, profile: undefined });
		const plan = allocate({ inventory: [foreign], leases: [], request: req, now: NOW, pidAlive: noPid });
		expect(plan).toEqual({ kind: "assign", steps: [{ action: "create", name: "warden-iphone-17-1" }], stale: [] });

		const adopted = allocate({
			inventory: [foreign],
			leases: [],
			request: { ...req, adopt: true },
			now: NOW,
			pidAlive: noPid,
		});
		expect(adopted).toEqual({ kind: "assign", steps: [{ action: "reuse", device: foreign }], stale: [] });
	});

	test("reclaims stale leases and reports them", () => {
		const stale = lease("1", { heartbeatAt: NOW - 120_000, pid: 99 });
		const plan = allocate({
			inventory: [sim({ id: "1", state: "booted" })],
			leases: [stale],
			request: req,
			now: NOW,
			pidAlive: noPid,
		});
		expect(plan.kind).toBe("assign");
		expect(plan.stale).toEqual(["lease-1"]);
	});

	test("lease with live pid is not stale", () => {
		const held = lease("1", { heartbeatAt: NOW - 120_000, pid: 99 });
		const plan = allocate({
			inventory: [sim({ id: "1", state: "booted" })],
			leases: [held],
			request: req,
			now: NOW,
			pidAlive: (pid) => pid === 99,
		});
		expect(plan.stale).toEqual([]);
		expect(plan.kind === "assign" && plan.steps[0]).toEqual({ action: "create", name: "warden-iphone-17-2" });
	});

	test("pool growth fills name gaps and stops at max", () => {
		const plan = allocate({
			inventory: [sim({ id: "a", name: "warden-iphone-17-2", state: "booted" })],
			leases: [lease("a")],
			request: { ...req, count: 2, max: 3 },
			now: NOW,
			pidAlive: noPid,
		});
		expect(plan).toEqual({
			kind: "assign",
			steps: [
				{ action: "create", name: "warden-iphone-17-1" },
				{ action: "create", name: "warden-iphone-17-3" },
			],
			stale: [],
		});
	});

	test("waits when pool is at max and all leased", () => {
		const plan = allocate({
			inventory: [sim({ id: "1" }), sim({ id: "2" })],
			leases: [lease("1"), lease("2")],
			request: { ...req, max: 2 },
			now: NOW,
			pidAlive: noPid,
		});
		expect(plan).toEqual({ kind: "wait", available: 0, needed: 1, stale: [] });
	});

	test("matches profile and runtime", () => {
		const other = sim({ id: "ipad", name: "warden-ipad-1", profile: "ipad" });
		const oldRuntime = sim({ id: "old", runtime: "iOS-18-0" });
		const good = sim({ id: "good" });
		const plan = allocate({
			inventory: [other, oldRuntime, good],
			leases: [],
			request: { ...req, runtime: "iOS-26-5" },
			now: NOW,
			pidAlive: noPid,
		});
		expect(plan.kind === "assign" && plan.steps).toEqual([{ action: "boot", device: good }]);
	});

	test("runtime latest prefers newest runtime", () => {
		const older = sim({ id: "old", runtime: "iOS-18-4" });
		const newer = sim({ id: "new", runtime: "iOS-26-5" });
		const plan = allocate({
			inventory: [older, newer],
			leases: [],
			request: { ...req, runtime: "latest" },
			now: NOW,
			pidAlive: noPid,
		});
		expect(plan.kind === "assign" && plan.steps).toEqual([{ action: "boot", device: newer }]);
	});

	test("ignores other platforms", () => {
		const android = sim({ id: "emulator-5554", platform: "android", state: "booted" });
		const plan = allocate({ inventory: [android], leases: [], request: req, now: NOW, pidAlive: noPid });
		expect(plan.kind === "assign" && plan.steps[0]?.action).toBe("create");
	});

	test("golden devices are never allocated, adopted or counted in the pool", () => {
		const golden = sim({ id: "G", name: "warden-golden-iphone-17-abc123def0", golden: true, wardenCreated: false });
		const plan = allocate({
			inventory: [golden],
			leases: [],
			request: { ...req, adopt: true, max: 1 },
			now: NOW,
			pidAlive: noPid,
		});
		expect(plan).toEqual({ kind: "assign", steps: [{ action: "create", name: "warden-iphone-17-1" }], stale: [] });
	});
});

describe("helpers", () => {
	test("profileSlug", () => {
		expect(profileSlug("iPhone 17 Pro")).toBe("iphone-17-pro");
		expect(profileSlug("  Pixel_8 API 35 ")).toBe("pixel-8-api-35");
	});

	test("wardenDeviceName", () => {
		expect(wardenDeviceName("iphone-17", 3)).toBe("warden-iphone-17-3");
	});

	test("defaultMax = cores/4 clamped to 1..4", () => {
		expect(defaultMax(2)).toBe(1);
		expect(defaultMax(8)).toBe(2);
		expect(defaultMax(14)).toBe(3);
		expect(defaultMax(64)).toBe(4);
	});
});

describe("allocate quarantine + skip", () => {
	test("never picks a quarantined device and frees its pool slot for a replacement", () => {
		const plan = allocate({
			inventory: [sim({ id: "1", quarantined: true })],
			leases: [],
			request: { ...req, max: 1 },
			now: NOW,
			pidAlive: noPid,
		});
		expect(plan).toEqual({ kind: "assign", steps: [{ action: "create", name: "warden-iphone-17-2" }], stale: [] });
	});

	test("skip ids are left out", () => {
		const plan = allocate({
			inventory: [sim({ id: "1", state: "booted" }), sim({ id: "2" })],
			leases: [],
			request: req,
			now: NOW,
			pidAlive: noPid,
			skip: new Set(["1"]),
		});
		expect(plan.kind === "assign" && plan.steps).toEqual([{ action: "boot", device: sim({ id: "2" }) }]);
	});
});
