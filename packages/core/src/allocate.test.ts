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

describe("allocate physical devices", () => {
	const phone = (id: string, overrides: Partial<InventoryDevice> = {}): InventoryDevice => ({
		platform: "android",
		id,
		name: `Pixel ${id}`,
		state: "booted",
		wardenCreated: false,
		profile: "pixel-8",
		runtime: "android-35",
		physical: { platform: "android", transport: "usb", adbState: "device" },
		...overrides,
	});
	const androidReq: DeviceRequest = { platform: "android", profile: "pixel-8", count: 1, max: 4 };
	const run = (inventory: InventoryDevice[], request: DeviceRequest, leases: Lease[] = []) =>
		allocate({ inventory, leases, request, now: NOW, pidAlive: noPid });

	test("a plain claim never takes a phone, even with --adopt", () => {
		expect(run([phone("P1")], androidReq).kind).toBe("assign");
		const plain = run([phone("P1")], { ...androidReq, adopt: true });
		expect(plain.kind === "assign" && plain.steps.map((s) => s.action)).toEqual(["create"]);
		const noRoom = run([phone("P1")], { ...androidReq, adopt: true, max: 0 });
		expect(noRoom.kind).toBe("wait");
	});

	test("a physical claim takes a ready phone regardless of profile, never creates", () => {
		const plan = run([phone("P1", { profile: "other" })], { ...androidReq, physical: {} });
		expect(plan.kind === "assign" && plan.steps).toEqual([
			{ action: "reuse", device: expect.objectContaining({ id: "P1" }) },
		]);
		const none = run([], { ...androidReq, physical: {} });
		expect(none.kind).toBe("wait");
	});

	test("a physical claim skips unauthorized phones and virtual devices", () => {
		const unauthorized = phone("P1", {
			state: "booting",
			physical: { platform: "android", transport: "usb", adbState: "unauthorized" },
		});
		const { physical: _phone, ...virtual } = phone("emulator-5554");
		const emulator: InventoryDevice = { ...virtual, wardenCreated: true };
		expect(run([unauthorized, emulator], { ...androidReq, physical: {} }).kind).toBe("wait");
	});

	test("ids filters; two phones with one leased gives the free one", () => {
		const inventory = [phone("P1"), phone("P2")];
		const both = run(inventory, { ...androidReq, physical: {} }, [
			lease("P1", { resource: { kind: "device", platform: "android", id: "P1", name: "P1" } }),
		]);
		expect(both.kind === "assign" && both.steps.map((s) => (s.action === "create" ? s.name : s.device.id))).toEqual([
			"P2",
		]);
		const only = run(inventory, { ...androidReq, physical: { ids: ["P2"] } });
		expect(only.kind === "assign" && only.steps.map((s) => (s.action === "create" ? s.name : s.device.id))).toEqual([
			"P2",
		]);
		expect(run(inventory, { ...androidReq, physical: { ids: ["nope"] } }).kind).toBe("wait");
	});

	test("an offline phone is never auto-picked", () => {
		const offline = phone("P1", { physical: { platform: "android", transport: "wifi", adbState: "offline" } });
		expect(run([offline], { ...androidReq, physical: {} }).kind).toBe("wait");
		expect(run([offline, phone("P2")], { ...androidReq, physical: {} }).kind).toBe("assign");
	});

	test("an unreachable iPhone/iPad is never picked, named or not", () => {
		const ipad = (id: string, unreachable?: string): InventoryDevice => ({
			platform: "ios",
			id,
			name: "Test iPad",
			state: unreachable === undefined ? "booted" : "shutdown",
			wardenCreated: false,
			physical: {
				platform: "ios",
				transport: "localNetwork",
				deviceType: "iPad",
				osVersion: "18.7.8",
				developerMode: true,
				ddi: true,
				...(unreachable === undefined ? {} : { unreachable }),
			},
		});
		const req: DeviceRequest = { platform: "ios", profile: "iphone-17", count: 1, max: 1, physical: {} };
		expect(run([ipad("A", "not connected")], req).kind).toBe("wait");
		expect(run([ipad("A", "not connected")], { ...req, physical: { ids: ["A"] } }).kind).toBe("wait");
		expect(run([ipad("A", "not connected"), ipad("B")], req).kind).toBe("assign");
	});

	test("an allowlist limits an id-less physical claim to the listed devices", () => {
		const inventory = [phone("P1"), phone("P2")];
		const plan = run(inventory, { ...androidReq, physical: { allow: ["P2"] } });
		expect(plan.kind === "assign" && plan.steps.map((s) => (s.action === "create" ? s.name : s.device.id))).toEqual([
			"P2",
		]);
		expect(run(inventory, { ...androidReq, physical: { allow: ["other"] } }).kind).toBe("wait");
	});

	test("naming a device beats the allowlist", () => {
		const plan = run([phone("P1"), phone("P2")], { ...androidReq, physical: { ids: ["P1"], allow: ["P2"] } });
		expect(plan.kind === "assign" && plan.steps.map((s) => (s.action === "create" ? s.name : s.device.id))).toEqual([
			"P1",
		]);
	});

	test("a phone named warden-x-1 stays foreign: not in the pool", () => {
		const named = phone("P1", { name: "warden-pixel-8-1" });
		const plan = run([named], { ...androidReq, max: 1 });
		expect(plan.kind === "assign" && plan.steps[0]?.action).toBe("create");
	});
});
