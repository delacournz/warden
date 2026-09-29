import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store, wardenHome } from "./store";
import type { Owner } from "./types";

let dir: string;
let store: Store;
const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-store-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("wardenHome", () => {
	test("WARDEN_HOME overrides ~/.warden", () => {
		expect(wardenHome({ WARDEN_HOME: "/x" })).toBe("/x");
		expect(wardenHome({ HOME: "/home/me" })).toBe("/home/me/.warden");
	});
});

describe("leases", () => {
	test("insert, get, list, delete", () => {
		const lease = store.insertLease({ resource: { kind: "port", port: 8091 }, owner, ttlMs: 1000, label: "x" }, 5);
		expect(lease.acquiredAt).toBe(5);
		expect(lease.heartbeatAt).toBe(5);
		expect(store.getLease(lease.id)).toEqual(lease);
		expect(store.listLeases()).toEqual([lease]);
		expect(store.deleteLeases([lease.id])).toBe(1);
		expect(store.listLeases()).toEqual([]);
	});

	test("same resource cannot be leased twice", () => {
		store.insertLease({ resource: { kind: "port", port: 8091 }, owner, ttlMs: 1000 }, 1);
		expect(() => store.insertLease({ resource: { kind: "port", port: 8091 }, owner, ttlMs: 1000 }, 2)).toThrow();
	});

	test("findLeaseByResource + heartbeat", () => {
		const lease = store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "U1", name: "n" }, owner, ttlMs: 1000, pid: 7 },
			1
		);
		expect(store.findLeaseByResource({ kind: "device", platform: "ios", id: "U1", name: "other" })?.id).toBe(lease.id);
		expect(store.heartbeat([lease.id], 50)).toBe(1);
		expect(store.getLease(lease.id)?.heartbeatAt).toBe(50);
		expect(store.getLease(lease.id)?.pid).toBe(7);
	});

	test("listLeasesByOwner", () => {
		store.insertLease({ resource: { kind: "port", port: 1 }, owner, ttlMs: 1 }, 1);
		store.insertLease({ resource: { kind: "port", port: 2 }, owner: { kind: "user", pid: 3, cwd: "/" }, ttlMs: 1 }, 1);
		expect(store.listLeasesByOwner(owner).map((l) => l.resource)).toEqual([{ kind: "port", port: 1 }]);
	});

	test("reclaimStale deletes dead leases only", () => {
		const dead = store.insertLease({ resource: { kind: "port", port: 1 }, owner, ttlMs: 10 }, 0);
		const live = store.insertLease({ resource: { kind: "port", port: 2 }, owner, ttlMs: 10_000 }, 0);
		expect(store.reclaimStale(100, () => false)).toEqual([dead.id]);
		expect(store.listLeases().map((l) => l.id)).toEqual([live.id]);
	});

	test("transaction rolls back on throw", () => {
		expect(() =>
			store.transaction(() => {
				store.insertLease({ resource: { kind: "port", port: 1 }, owner, ttlMs: 1 }, 1);
				throw new Error("boom");
			})
		).toThrow("boom");
		expect(store.listLeases()).toEqual([]);
	});
});

describe("devices", () => {
	test("record, list, touch, forget", () => {
		store.recordDevice(
			{ platform: "ios", id: "U1", name: "warden-iphone-17-1", profile: "iphone-17", runtime: "iOS-26-5" },
			10
		);
		expect(store.listDevices("ios")).toEqual([
			{
				platform: "ios",
				id: "U1",
				name: "warden-iphone-17-1",
				profile: "iphone-17",
				runtime: "iOS-26-5",
				createdAt: 10,
				lastUsedAt: 10,
			},
		]);
		store.touchDevice("ios", "U1", 20);
		expect(store.listDevices()[0]?.lastUsedAt).toBe(20);
		expect(store.listDevices("android")).toEqual([]);
		store.forgetDevice("ios", "U1");
		expect(store.listDevices()).toEqual([]);
	});
});

describe("concurrency", () => {
	test("concurrent claim processes never receive the same port", async () => {
		const dbPath = join(dir, "race.db");
		openStore(dbPath).close();
		const script = join(import.meta.dir, "store.race-fixture.ts");
		const procs = Array.from({ length: 6 }, () =>
			Bun.spawn(["bun", script, dbPath], { stdout: "pipe", stderr: "inherit" })
		);
		const ports = await Promise.all(procs.map(async (p) => Number((await new Response(p.stdout).text()).trim())));
		expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0, 0, 0]);
		expect(new Set(ports).size).toBe(6);
	});
});
