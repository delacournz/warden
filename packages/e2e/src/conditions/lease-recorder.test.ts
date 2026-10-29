import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeConditions, recordCondition } from "@delacour/warden-core/conditions/conditions";
import { undoConditions } from "@delacour/warden-core/conditions/undo";
import type { Exec } from "@delacour/warden-core/exec";
import { openStore, type Store } from "@delacour/warden-core/store";
import type { Lease } from "@delacour/warden-core/types";
import { err, ok } from "@delacour/warden-types/result";
import { fakeDriver, snapshotOf } from "../driver/driver.testing";
import type { Driver, DriverResult } from "../driver/driver.types";
import type { E2eEnv } from "../env";
import { createDeviceConditions } from "./device-conditions";
import { createLeaseRecorder, leaseRecorderFor } from "./lease-recorder";
import { sharedStoreOpener } from "./lease-store";

let dir: string;
let store: Store;
let lease: Lease;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-recorder-"));
	store = openStore(join(dir, "warden.db"));
	lease = store.insertLease(
		{
			resource: { kind: "device", platform: "android", id: "emulator-5554", name: "Pixel" },
			owner: { kind: "agent", sessionId: "s", cwd: "/tmp" },
			ttlMs: 60_000,
		},
		1
	);
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const recorder = (log: string[] = []) =>
	createLeaseRecorder({ leaseId: lease.id, openStore: () => ok(store), now: () => 42, log: (l) => log.push(l) });

describe("createLeaseRecorder", () => {
	test("record writes the area to the lease", () => {
		recorder().record("network", { kind: "offline" });
		expect(activeConditions(store, lease.id)).toMatchObject([
			{ area: "network", value: { kind: "offline" }, setAt: 42 },
		]);
	});

	test("settle forgets a neutral area", () => {
		const r = recorder();
		r.record("location", { kind: "point", lat: 1, lon: 2 });
		r.settle("location", { kind: "clear" }, true);
		expect(activeConditions(store, lease.id)).toEqual([]);
	});

	test("settle keeps a non-neutral baseline as the recorded value", () => {
		const r = recorder();
		r.record("network", { kind: "offline" });
		r.settle("network", { kind: "preset", preset: "3g" }, false);
		expect(activeConditions(store, lease.id)).toMatchObject([
			{ area: "network", value: { kind: "preset", preset: "3g" } },
		]);
	});

	test("settle keeps the row while a process it owns is alive, so release still stops it", () => {
		recordCondition(store, lease.id, "network", { kind: "offline" }, 1, [{ kind: "pid", pid: 4242 }]);
		const alive = createLeaseRecorder({
			leaseId: lease.id,
			openStore: () => ok(store),
			pidAlive: () => true,
			log: () => {},
		});
		alive.settle("network", { kind: "online" }, true);
		expect(activeConditions(store, lease.id)).toMatchObject([
			{ area: "network", value: { kind: "online" }, owned: [{ pid: 4242 }] },
		]);
		const dead = createLeaseRecorder({
			leaseId: lease.id,
			openStore: () => ok(store),
			pidAlive: () => false,
			log: () => {},
		});
		dead.settle("network", { kind: "online" }, true);
		expect(activeConditions(store, lease.id)).toEqual([]);
	});

	test("a store that cannot open, or a lease that is gone, is logged and never thrown", () => {
		const log: string[] = [];
		createLeaseRecorder({ leaseId: lease.id, openStore: () => err("disk on fire"), log: (l) => log.push(l) }).record(
			"clock",
			{ kind: "real" }
		);
		createLeaseRecorder({
			leaseId: lease.id,
			openStore: () => {
				throw new Error("boom");
			},
			log: (l) => log.push(l),
		}).settle("clock", { kind: "real" }, true);
		createLeaseRecorder({ leaseId: "nope", openStore: () => ok(store), log: (l) => log.push(l) }).record("clock", {
			kind: "real",
		});
		expect(log).toHaveLength(3);
		expect(log[0]).toContain("disk on fire");
		expect(log[1]).toContain("boom");
		expect(log[2]).toContain("no lease nope");
	});
});

describe("leaseRecorderFor", () => {
	test("none without a lease id", () => {
		expect(leaseRecorderFor({})).toBeUndefined();
		expect(leaseRecorderFor({ leaseId: "L" })).toBeDefined();
	});
});

describe("sharedStoreOpener", () => {
	test("opens the store at WARDEN_HOME on first call and reuses it", () => {
		const open = sharedStoreOpener({ WARDEN_HOME: dir });
		const first = open();
		expect(first.success).toBe(true);
		expect(sharedStoreOpener({ WARDEN_HOME: dir })()).toEqual(first);
	});
});

describe("a spec that dies mid-test", () => {
	const env: E2eEnv = {
		udid: "emulator-5554",
		platform: "android",
		bundleId: "com.example.app",
		launchArgs: [],
		out: "/tmp/out",
		timeoutMs: 1000,
		actionTimeoutMs: 1000,
		assertionTimeoutMs: 1000,
		logTimestamps: false,
	};

	test("the offline it set is on the lease, and release undoes it with the Android resets", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([], { platform: "android" })], platform: "android" });
		const conditions = createDeviceConditions({
			driver,
			env,
			signal: () => undefined,
			recorder: recorder(),
			log: () => {},
		});
		await conditions.network.set("offline");
		await conditions.location.set({ lat: -36.85, lon: 174.76 });
		// the process dies here: no teardown runs
		expect(activeConditions(store, lease.id).map((r) => r.area)).toEqual(["network", "location"]);

		const calls: string[][] = [];
		const exec: Exec = async (cmd) => {
			calls.push([...cmd]);
			return { exitCode: 0, stdout: "", stderr: "" };
		};
		const undone = await undoConditions(
			{ store, exec, env: {}, now: () => 9, pidAlive: () => false, kill: () => {} },
			lease
		);
		expect(undone.success).toBe(true);
		expect(calls.some((c) => c.join(" ").endsWith("shell cmd connectivity airplane-mode disable"))).toBe(true);
		expect(activeConditions(store, lease.id)).toEqual([]);
	});

	test("a normal teardown puts the baseline back and leaves nothing for release to redo", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([], { platform: "android" })], platform: "android" });
		const conditions = createDeviceConditions({
			driver,
			env,
			signal: () => undefined,
			recorder: recorder(),
			log: () => {},
		});
		(driver as Driver & { clock?: () => DriverResult<undefined> }).clock = async () => ok(undefined);
		await conditions.network.set("offline");
		await conditions.location.set({ lat: 1, lon: 2 });
		await conditions.clock.set("2030-01-01T00:00:00Z");
		await conditions.internals.teardown();
		expect(activeConditions(store, lease.id)).toEqual([]);
	});

	test("a suite baseline stays recorded after teardown, as the lease's state", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([], { platform: "android" })], platform: "android" });
		const conditions = createDeviceConditions({
			driver,
			env: { ...env, conditions: { network: "3g" } },
			signal: () => undefined,
			recorder: recorder(),
			log: () => {},
		});
		await conditions.internals.applyBaseline();
		await conditions.network.set("offline");
		await conditions.internals.teardown();
		expect(activeConditions(store, lease.id)).toMatchObject([
			{ area: "network", value: { kind: "preset", preset: "3g" } },
		]);
	});

	test("a failing driver call records nothing and a failing store never fails the call", async () => {
		const driver = fakeDriver({ screens: [snapshotOf([], { platform: "android" })], platform: "android" });
		const log: string[] = [];
		const broken = createLeaseRecorder({ leaseId: lease.id, openStore: () => err("locked"), log: (l) => log.push(l) });
		const conditions = createDeviceConditions({
			driver,
			env,
			signal: () => undefined,
			recorder: broken,
			log: () => {},
		});
		await conditions.network.set("offline");
		expect((await conditions.network.status()).condition).toEqual({ kind: "offline" });
		expect(log.length).toBeGreaterThan(0);
	});
});
