import { describe, expect, test } from "bun:test";
import {
	deleteAfterShutdown,
	devKeepsSim,
	ephemeralEnabled,
	shouldShutdown,
	staleForMs,
	staleShutdownBlock,
} from "./shutdown-policy";
import type { DeviceRecord } from "./store";
import type { Lease } from "./types";

const lease = (o: Partial<Lease> = {}): Lease => ({
	id: "l",
	resource: { kind: "device", platform: "ios", id: "U1", name: "n" },
	owner: { kind: "agent", sessionId: "s", cwd: "/" },
	acquiredAt: 0,
	heartbeatAt: 0,
	ttlMs: 1,
	...o,
});

describe("staleShutdownBlock", () => {
	const stale = lease({ heartbeatAt: 0, ttlMs: 60_000 });
	const min = 60_000;

	test("stale under 10 min → blocked", () => {
		expect(staleShutdownBlock(stale, 60_000 + 9 * min, false)).toContain("grace");
		expect(staleShutdownBlock(stale, 60_000, false)).toContain("0m ago");
	});

	test("stale 10+ min, nothing running → allowed", () => {
		expect(staleShutdownBlock(stale, 60_000 + 10 * min, false)).toBeUndefined();
	});

	test("stale 10+ min but app running → blocked", () => {
		expect(staleShutdownBlock(stale, 60_000 + 30 * min, true)).toContain("app is running");
	});

	test("staleForMs never negative", () => {
		expect(staleForMs(stale, 0)).toBe(0);
		expect(staleForMs(stale, 90_000)).toBe(30_000);
	});
});

describe("shouldShutdown", () => {
	test("a physical device is never shut down, whatever the records or bootedByOwner say", () => {
		const phone = lease({
			bootedByOwner: true,
			resource: { kind: "device", platform: "android", id: "P1", name: "n", physical: { transport: "usb" } },
		});
		expect(shouldShutdown(phone, new Set(["android:P1"]))).toBe(false);
	});

	test("warden-created device → yes", () => {
		expect(shouldShutdown(lease(), new Set(["ios:U1"]))).toBe(true);
	});

	test("device the owner booted → yes, even if not warden's", () => {
		expect(shouldShutdown(lease({ bootedByOwner: true }), new Set())).toBe(true);
	});

	test("someone else's already-running device → no", () => {
		expect(shouldShutdown(lease(), new Set())).toBe(false);
	});

	test("non-device leases → no", () => {
		expect(shouldShutdown(lease({ resource: { kind: "port", port: 1 }, bootedByOwner: true }), new Set())).toBe(false);
	});
});

describe("ephemeralEnabled", () => {
	test("on by default", () => {
		expect(ephemeralEnabled({})).toBe(true);
		expect(ephemeralEnabled({ WARDEN_EPHEMERAL: "1" })).toBe(true);
	});

	test("WARDEN_EPHEMERAL=0/false/off/no (any case) turns it off", () => {
		for (const v of ["0", "false", "OFF", " no "]) expect(ephemeralEnabled({ WARDEN_EPHEMERAL: v })).toBe(false);
	});

	test("off without goldens: a fresh sim would be a slow simctl create", () => {
		expect(ephemeralEnabled({ WARDEN_GOLDEN: "0" })).toBe(false);
	});
});

describe("devKeepsSim", () => {
	test("on by default: `warden dev` keeps its sim", () => {
		expect(devKeepsSim({})).toBe(true);
	});

	test("WARDEN_EPHEMERAL_DEV=1/true/on/yes makes dev sims ephemeral too", () => {
		for (const v of ["1", "true", "ON", " yes "]) expect(devKeepsSim({ WARDEN_EPHEMERAL_DEV: v })).toBe(false);
	});
});

describe("deleteAfterShutdown", () => {
	const record = (o: Partial<DeviceRecord> = {}): DeviceRecord => ({
		platform: "ios",
		id: "U1",
		name: "warden-iphone-17-1",
		createdAt: 0,
		lastUsedAt: 0,
		...o,
	});

	test("a warden-created iOS sim → yes", () => {
		expect(deleteAfterShutdown(record())).toBe(true);
	});

	test("no warden record (foreign, or only booted by the owner) → no", () => {
		expect(deleteAfterShutdown(undefined)).toBe(false);
	});

	test("a quarantined sim is kept for `warden sim unquarantine`", () => {
		expect(deleteAfterShutdown(record({ quarantinedAt: 5 }))).toBe(false);
	});

	test("a persistent sim (`warden dev`'s) is kept so its installs and logins survive", () => {
		expect(deleteAfterShutdown(record({ persistentAt: 5 }))).toBe(false);
	});

	test("Android emulators are not ephemeral", () => {
		expect(deleteAfterShutdown(record({ platform: "android" }))).toBe(false);
	});

	test("a golden is never deleted here", () => {
		expect(deleteAfterShutdown(record({ name: "warden-golden-iphone-17-iOS-26-5" }))).toBe(false);
	});
});
