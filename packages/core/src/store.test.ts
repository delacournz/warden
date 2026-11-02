import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getInstall, listBuilds, recordInstall } from "./builds/cache";
import { MIGRATIONS, openStore, QUEUE_TTL_MS, type Store, wardenHome } from "./store";
import type { Owner, QueueEntry } from "./types";

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

	test("heartbeat with a period marks the leases supervised; a plain heartbeat keeps the period", () => {
		const lease = store.insertLease({ resource: { kind: "port", port: 1 }, owner, ttlMs: 60_000, pid: 7 }, 0);
		expect(store.getLease(lease.id)?.heartbeatMs).toBeUndefined();
		expect(store.heartbeat([lease.id], 10, 30_000)).toBe(1);
		expect(store.getLease(lease.id)).toMatchObject({ heartbeatAt: 10, heartbeatMs: 30_000 });
		expect(store.heartbeat([lease.id], 20)).toBe(1);
		expect(store.getLease(lease.id)).toMatchObject({ heartbeatAt: 20, heartbeatMs: 30_000 });
	});

	test("reclaimStale takes a supervised lease three periods after its pid died, a pid-less one at the TTL", () => {
		const supervised = store.insertLease({ resource: { kind: "port", port: 1 }, owner, ttlMs: 30 * 60_000, pid: 7 }, 0);
		const pidless = store.insertLease({ resource: { kind: "port", port: 2 }, owner, ttlMs: 30 * 60_000 }, 0);
		store.heartbeat([supervised.id, pidless.id], 1_000, 30_000);
		expect(store.reclaimStale(1_000 + 90_000, () => false)).toEqual([]);
		expect(store.reclaimStale(1_000 + 90_001, () => true)).toEqual([]);
		expect(store.reclaimStale(1_000 + 90_001, () => false)).toEqual([supervised.id]);
		expect(store.listLeases().map((l) => l.id)).toEqual([pidless.id]);
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

describe("bootedByOwner + meta", () => {
	test("lease remembers its owner booted the device", () => {
		const lease = store.insertLease(
			{ resource: { kind: "device", platform: "ios", id: "U1", name: "n" }, owner, ttlMs: 1000, bootedByOwner: true },
			1
		);
		expect(store.getLease(lease.id)?.bootedByOwner).toBe(true);
		const plain = store.insertLease({ resource: { kind: "port", port: 1 }, owner, ttlMs: 1 }, 1);
		expect(store.getLease(plain.id)?.bootedByOwner).toBeUndefined();
		store.markBootedByOwner(plain.id);
		expect(store.getLease(plain.id)?.bootedByOwner).toBe(true);
	});

	test("shared: insertLease + markShared round-trip (a `warden dev` lease other own processes may drive)", () => {
		const resource = { kind: "device", platform: "ios", id: "U2", name: "n" } as const;
		const shared = store.insertLease({ resource, owner, ttlMs: 1000, shared: true }, 1);
		expect(store.getLease(shared.id)?.shared).toBe(true);
		const plain = store.insertLease({ resource: { kind: "port", port: 2 }, owner, ttlMs: 1 }, 1);
		expect(store.getLease(plain.id)?.shared).toBeUndefined();
		store.markShared([plain.id]);
		expect(store.getLease(plain.id)?.shared).toBe(true);
	});

	test("meta get/set", () => {
		expect(store.getMeta("last_gc_at")).toBeUndefined();
		store.setMeta("last_gc_at", "5");
		store.setMeta("last_gc_at", "6");
		expect(store.getMeta("last_gc_at")).toBe("6");
		store.deleteMeta("last_gc_at");
		store.deleteMeta("never_set");
		expect(store.getMeta("last_gc_at")).toBeUndefined();
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

describe("reclaim versus heartbeat", () => {
	const script = join(import.meta.dir, "heartbeat.race-fixture.ts");
	const holder = (dbPath: string, id: string, args: { periodMs: number; everyMs: number; beats: number }) =>
		Bun.spawn(["bun", script, dbPath, id, `${args.periodMs}`, `${args.everyMs}`, `${args.beats}`], {
			stdout: "pipe",
			stderr: "inherit",
		});
	const beats = async (proc: ReturnType<typeof holder>) =>
		(await new Response(proc.stdout).text()).trim().split("\n").map(Number);

	test("a dead-pid supervised lease is never reclaimed while another process keeps heartbeating it", async () => {
		const dbPath = join(dir, "hb-race.db");
		const local = openStore(dbPath);
		const lease = local.insertLease({ resource: { kind: "port", port: 1 }, owner, ttlMs: 60_000, pid: 7 }, Date.now());
		const proc = holder(dbPath, lease.id, { periodMs: 100, everyMs: 10, beats: 30 });
		const reclaimed: string[] = [];
		let exited = false;
		void proc.exited.then(() => {
			exited = true;
		});
		while (!exited) {
			reclaimed.push(...local.reclaimStale(Date.now(), () => false));
			await Bun.sleep(5);
		}
		expect(await proc.exited).toBe(0);
		expect(reclaimed).toEqual([]);
		expect(new Set(await beats(proc))).toEqual(new Set([1]));
		const last = local.getLease(lease.id);
		expect(last?.heartbeatMs).toBe(100);
		const at = last?.heartbeatAt ?? 0;
		expect(local.reclaimStale(at + 300, () => false)).toEqual([]);
		expect(local.reclaimStale(at + 301, () => false)).toEqual([lease.id]);
		local.close();
	});

	test("once reclaimed, the holder's next heartbeat updates nothing and does not bring the lease back", async () => {
		const dbPath = join(dir, "hb-lost.db");
		const local = openStore(dbPath);
		const lease = local.insertLease({ resource: { kind: "port", port: 1 }, owner, ttlMs: 60_000, pid: 7 }, Date.now());
		const proc = holder(dbPath, lease.id, { periodMs: 100, everyMs: 10, beats: 2_000 });
		while (local.getLease(lease.id)?.heartbeatMs === undefined) await Bun.sleep(5);
		expect(local.reclaimStale(Date.now() + 60_001, () => false)).toEqual([lease.id]);
		expect(await proc.exited).toBe(0);
		const counts = await beats(proc);
		expect(counts.at(-1)).toBe(0);
		expect(counts.slice(0, -1).every((n) => n === 1)).toBe(true);
		expect(local.getLease(lease.id)).toBeUndefined();
		local.close();
	});
});

describe("device quarantine + slim state", () => {
	const dev = { platform: "ios", id: "U1", name: "warden-iphone-17-1", profile: "iphone-17" } as const;

	test("quarantine records reason + time, survives recordDevice, unquarantine clears", () => {
		store.recordDevice(dev, 1);
		store.quarantineDevice(dev, "dictation loop", 5);
		expect(store.listDevices()[0]).toMatchObject({ id: "U1", quarantinedAt: 5, quarantineReason: "dictation loop" });
		store.recordDevice(dev, 9);
		expect(store.listDevices()[0]?.quarantinedAt).toBe(5);
		expect(store.unquarantineDevice("U1")).toBe(1);
		expect(store.listDevices()[0]?.quarantinedAt).toBeUndefined();
		expect(store.unquarantineDevice("U1")).toBe(0);
	});

	test("quarantine inserts a device only known by name", () => {
		store.quarantineDevice(dev, undefined, 5);
		expect(store.listDevices()).toHaveLength(1);
		expect(store.listDevices()[0]?.quarantineReason).toBeUndefined();
	});

	test("setSlimmed sets and clears", () => {
		store.recordDevice(dev, 1);
		store.setSlimmed("ios", "U1", 7);
		expect(store.listDevices()[0]?.slimmedAt).toBe(7);
		store.setSlimmed("ios", "U1", undefined);
		expect(store.listDevices()[0]?.slimmedAt).toBeUndefined();
	});

	test("markPersistent stamps a recorded device, keeps its profile, survives recordDevice", () => {
		store.recordDevice(dev, 1);
		store.markPersistent("ios", "U1", 7);
		store.recordDevice(dev, 9);
		expect(store.listDevices()[0]).toMatchObject({ persistentAt: 7, profile: "iphone-17" });
	});

	test("markPersistent never records a device only known by name (that would make it warden-created)", () => {
		store.markPersistent("ios", "U1", 7);
		expect(store.listDevices()).toEqual([]);
	});

	test("migrates a database created before the columns existed", () => {
		const old = join(dir, "old.db");
		const db = new Database(old, { create: true });
		for (const sql of MIGRATIONS.slice(0, 3)) db.exec(sql);
		db.exec("PRAGMA user_version = 3");
		db.exec("INSERT INTO devices VALUES ('ios', 'U9', 'warden-iphone-17-9', 'iphone-17', NULL, 1, 1)");
		db.close();
		const migrated = openStore(old);
		expect(migrated.listDevices()[0]).toMatchObject({ id: "U9" });
		migrated.quarantineDevice(dev, "x", 2);
		expect(migrated.listDevices().find((d) => d.id === "U1")?.quarantinedAt).toBe(2);
		migrated.close();
	});
});

describe("lease heartbeat period migration", () => {
	test("a database from before heartbeat_ms upgrades; old leases keep a NULL period (TTL rule)", () => {
		const old = join(dir, "old-leases.db");
		const db = new Database(old, { create: true });
		for (const sql of MIGRATIONS.slice(0, 4)) db.exec(sql);
		db.exec("PRAGMA user_version = 4");
		db.exec(
			`INSERT INTO leases (id, resource_key, resource, owner_key, owner, label, acquired_at, heartbeat_at, ttl_ms, pid)
			 VALUES ('l_old', 'port:1', '{"kind":"port","port":1}', 'agent:s1', '{"kind":"agent","sessionId":"s1","cwd":"/tmp"}', NULL, 0, 0, 60000, 7)`
		);
		db.close();
		const migrated = openStore(old);
		const column = migrated.db
			.query<{ name: string; notnull: number }, []>("PRAGMA table_info(leases)")
			.all()
			.find((c) => c.name === "heartbeat_ms");
		expect(column).toEqual(expect.objectContaining({ name: "heartbeat_ms", notnull: 0 }));
		expect(migrated.getLease("l_old")).toMatchObject({ id: "l_old", pid: 7 });
		expect(migrated.getLease("l_old")?.heartbeatMs).toBeUndefined();
		expect(migrated.reclaimStale(59_000, () => false)).toEqual([]);
		migrated.close();
	});
});

describe("build kinds migration", () => {
	test("a database from before kinds keeps its builds as legacy, with empty kind columns", () => {
		const old = join(dir, "old-builds.db");
		const db = new Database(old, { create: true });
		const beforeKinds = MIGRATIONS.findIndex((sql) => sql.includes("ADD COLUMN kind"));
		for (const sql of MIGRATIONS.slice(0, beforeKinds)) db.exec(sql);
		db.exec(`PRAGMA user_version = ${beforeKinds}`);
		db.exec("INSERT INTO builds VALUES ('k', 'ios', 'p', 'H', '/c/H/A.app', 'build', 5, 1, 2)");
		db.close();
		const migrated = openStore(old);
		const columns = migrated.db
			.query<{ name: string }, []>("PRAGMA table_info(builds)")
			.all()
			.map((c) => c.name);
		expect(columns).toEqual([
			"project_key",
			"platform",
			"profile",
			"hash",
			"path",
			"source",
			"size",
			"created_at",
			"last_used_at",
			"kind",
			"base_hash",
			"js_key",
			"worktree",
			"branch",
		]);
		expect(migrated.db.query("SELECT kind, base_hash, js_key, worktree, branch FROM builds").get()).toEqual({
			kind: "legacy",
			base_hash: null,
			js_key: null,
			worktree: null,
			branch: null,
		});
		expect(listBuilds(migrated)).toEqual([
			{
				projectKey: "k",
				platform: "ios",
				profile: "p",
				hash: "H",
				path: "/c/H/A.app",
				source: "build",
				size: 5,
				createdAt: 1,
				lastUsedAt: 2,
			},
		]);
		migrated.close();
	});
});

describe("fingerprints memo migration (17-5)", () => {
	test("a database from before the fingerprints table upgrades and gets an empty one", () => {
		const old = join(dir, "old-fp.db");
		const db = new Database(old, { create: true });
		for (const sql of MIGRATIONS.slice(0, 5)) db.exec(sql);
		db.exec("PRAGMA user_version = 5");
		db.close();
		const migrated = openStore(old);
		const columns = migrated.db
			.query<{ name: string }, []>("PRAGMA table_info(fingerprints)")
			.all()
			.map((c) => c.name);
		expect(columns).toEqual(["root", "platform", "variant", "command", "signature", "native", "computed_at"]);
		migrated.close();
	});
});

describe("installs identity migration (17-7)", () => {
	test("an install recorded before the container columns existed reads back without them", () => {
		const old = join(dir, "old-installs.db");
		const db = new Database(old, { create: true });
		for (const sql of MIGRATIONS.slice(0, 6)) db.exec(sql);
		db.exec("PRAGMA user_version = 6");
		db.exec("INSERT INTO installs VALUES ('ios', 'U1', 'com.x', 'H', 1)");
		db.close();
		const migrated = openStore(old);
		expect(getInstall(migrated, "ios", "U1", "com.x")).toEqual({
			platform: "ios",
			deviceId: "U1",
			bundleId: "com.x",
			hash: "H",
			installedAt: 1,
		});
		recordInstall(migrated, {
			platform: "ios",
			deviceId: "U1",
			bundleId: "com.x",
			hash: "H2",
			installedAt: 2,
			container: "/c/App.app",
			exeStamp: "1:2",
		});
		expect(getInstall(migrated, "ios", "U1", "com.x")).toMatchObject({ container: "/c/App.app", exeStamp: "1:2" });
		recordInstall(migrated, { platform: "ios", deviceId: "U1", bundleId: "com.x", hash: "H3", installedAt: 3 });
		expect(getInstall(migrated, "ios", "U1", "com.x")?.container).toBeUndefined();
		migrated.close();
	});
});

describe("pragmas", () => {
	test("WAL with synchronous NORMAL: a commit does not fsync, a crash cannot corrupt", () => {
		expect(store.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
		expect(store.db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous).toBe(1);
		expect(store.db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(15000);
	});
});

describe("gcWork", () => {
	const IDLE = 20 * 60_000;
	const NOW = 100 * 60_000;
	const dead = () => false;
	const device = (id: string) => ({ platform: "ios" as const, id, name: `warden-iphone-17-${id}` });
	const lease = (id: string) => ({
		kind: "device" as const,
		platform: "ios" as const,
		id,
		name: `warden-iphone-17-${id}`,
	});

	test("nothing stale and nothing idle: no work", () => {
		store.insertLease({ resource: lease("U1"), owner, ttlMs: 60_000 }, NOW);
		store.recordDevice(device("U1"), NOW - 60_000);
		store.recordDevice(device("U2"), NOW - 5 * 60_000);
		expect(store.gcWork(NOW, IDLE, dead)).toEqual({ staleLeases: 0, idleDevices: 0 });
	});

	test("an empty store has no work", () => {
		expect(store.gcWork(NOW, IDLE, dead)).toEqual({ staleLeases: 0, idleDevices: 0 });
	});

	test("a lease whose heartbeat expired and whose pid is gone is stale; a live pid keeps it", () => {
		store.insertLease({ resource: lease("U1"), owner, ttlMs: 1_000, pid: 4242 }, 0);
		store.insertLease({ resource: { kind: "port", port: 9 }, owner, ttlMs: 1_000 }, 0);
		expect(store.gcWork(NOW, IDLE, dead).staleLeases).toBe(2);
		expect(store.gcWork(NOW, IDLE, (pid) => pid === 4242).staleLeases).toBe(1);
	});

	test("an unleased device idle for the window is work; a leased or recently used one is not", () => {
		store.recordDevice(device("U1"), NOW - IDLE);
		store.recordDevice(device("U2"), NOW - IDLE - 1);
		store.recordDevice(device("U3"), NOW - IDLE + 1);
		store.insertLease({ resource: lease("U2"), owner, ttlMs: 60_000 }, NOW);
		expect(store.gcWork(NOW, IDLE, dead).idleDevices).toBe(1);
	});

	test("a device that was already idle when the last gc ran is not work again until it is used", () => {
		store.recordDevice(device("U1"), 10 * 60_000);
		store.recordDevice(device("U2"), 70 * 60_000);
		expect(store.gcWork(NOW, IDLE, dead).idleDevices).toBe(2);
		store.setMeta("last_gc_at", String(60 * 60_000));
		expect(store.gcWork(NOW, IDLE, dead).idleDevices).toBe(1);
		store.setMeta("last_gc_at", String(NOW));
		expect(store.gcWork(NOW, IDLE, dead).idleDevices).toBe(0);
		store.touchDevice("ios", "U1", 105 * 60_000);
		expect(store.gcWork(105 * 60_000 + IDLE, IDLE, dead).idleDevices).toBe(1);
		expect(store.gcWork(105 * 60_000 + IDLE - 1, IDLE, dead).idleDevices).toBe(0);
	});

	test("devices of every platform count; the lease must be on that platform's device", () => {
		store.recordDevice({ platform: "android", id: "emulator-5554", name: "warden-pixel-10-1" }, 0);
		store.recordDevice({ platform: "ios", id: "emulator-5554", name: "warden-iphone-17-x" }, 0);
		store.insertLease(
			{
				resource: { kind: "device", platform: "android", id: "emulator-5554", name: "warden-pixel-10-1" },
				owner,
				ttlMs: 60_000,
			},
			NOW
		);
		expect(store.gcWork(NOW, IDLE, dead).idleDevices).toBe(1);
	});
});

describe("boot queue", () => {
	const newEntry = (id: string, now: number, over: Partial<QueueEntry> = {}): QueueEntry => ({
		id,
		platform: "ios",
		profile: "iphone-17",
		units: 1,
		priority: 10,
		enqueuedAt: now,
		heartbeatAt: now,
		owner,
		...over,
	});

	test("enqueue, list, refresh, dequeue round-trip", () => {
		const full = newEntry("q1", 5, { label: "x", pid: 7 });
		expect(store.enqueue(full)).toEqual(full);
		store.enqueue(newEntry("q2", 6));
		expect(store.listQueue()).toEqual([full, newEntry("q2", 6)]);
		expect(store.refreshQueue("q1", 50)).toBe(true);
		expect(store.listQueue()[0]?.heartbeatAt).toBe(50);
		expect(store.dequeue("q1")).toBe(true);
		expect(store.dequeue("q1")).toBe(false);
		expect(store.refreshQueue("q1", 60)).toBe(false);
		expect(store.listQueue().map((e) => e.id)).toEqual(["q2"]);
	});

	test("re-enqueue of the same id keeps enqueuedAt and priority", () => {
		store.enqueue(newEntry("q1", 5));
		const again = store.enqueue(newEntry("q1", 99, { units: 3, priority: 0 }));
		expect(again.enqueuedAt).toBe(5);
		expect(again.units).toBe(3);
	});

	test("reclaimStaleQueue drops dead pids and stale heartbeats, keeps live ones", () => {
		store.enqueue(newEntry("dead", 0, { pid: 1 }));
		store.enqueue(newEntry("live", 0, { pid: 2 }));
		store.enqueue(newEntry("nopid-fresh", 0));
		const now = 1000;
		expect(store.reclaimStaleQueue(now, (pid) => pid === 2)).toEqual(["dead"]);
		expect(store.listQueue().map((e) => e.id)).toEqual(["live", "nopid-fresh"]);
		expect(store.reclaimStaleQueue(QUEUE_TTL_MS, () => true)).toEqual([]);
		expect(store.reclaimStaleQueue(QUEUE_TTL_MS + 1, () => true).sort()).toEqual(["live", "nopid-fresh"]);
	});

	test("migration adds boot_queue to an existing db", () => {
		const old = join(dir, "old-queue.db");
		const db = new Database(old, { create: true });
		for (const sql of MIGRATIONS.slice(0, -1)) db.exec(sql);
		db.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
		db.close();
		const migrated = openStore(old);
		expect(migrated.listQueue()).toEqual([]);
		migrated.enqueue(newEntry("q1", 1));
		expect(migrated.listQueue()).toHaveLength(1);
		migrated.close();
	});

	test("migration adds orphan_conditions and its trigger to a database that has lease_conditions", () => {
		const old = join(dir, "old-orphans.db");
		const db = new Database(old, { create: true });
		for (const sql of MIGRATIONS.slice(0, -1)) db.exec(sql);
		db.exec(`PRAGMA user_version = ${MIGRATIONS.length - 1}`);
		db.close();
		const migrated = openStore(old);
		const lease = migrated.insertLease(
			{
				resource: { kind: "device", platform: "ios", id: "U1", name: "n" },
				owner: { kind: "user", pid: 1, cwd: "/" },
				ttlMs: 1,
			},
			1
		);
		migrated.db
			.query("INSERT INTO lease_conditions (lease_id, area, json, owned, set_at) VALUES (?, 'battery', '{}', '[]', 1)")
			.run(lease.id);
		migrated.deleteLeases([lease.id]);
		expect(migrated.db.query("SELECT lease_id, area FROM orphan_conditions").all()).toEqual([
			{ lease_id: lease.id, area: "battery" },
		]);
		migrated.close();
	});

	test("concurrent enqueues from many processes all land", async () => {
		const dbPath = join(dir, "queue-race.db");
		openStore(dbPath).close();
		const script = join(import.meta.dir, "queue.race-fixture.ts");
		const procs = Array.from({ length: 6 }, (_, i) =>
			Bun.spawn(["bun", script, dbPath, `r${i}`], { stdout: "pipe", stderr: "inherit" })
		);
		expect(await Promise.all(procs.map((p) => p.exited))).toEqual([0, 0, 0, 0, 0, 0]);
		const local = openStore(dbPath);
		expect(
			local
				.listQueue()
				.map((e) => e.id)
				.sort()
		).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
		local.close();
	});
});
