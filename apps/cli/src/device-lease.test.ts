import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TTL_MS } from "@delacour/warden-core/config.defaults";
import { openStore, type Store } from "@delacour/warden-core/store";
import type { DeviceResource, Owner } from "@delacour/warden-core/types";
import { blockMessage, busyMessage, ensureCallerLease, releaseDevices } from "./device-lease";

const UDID = "0A1B2C3D-4E5F-6A7B-8C9D-0E1F2A3B4C5D";
const me: Owner = { kind: "agent", sessionId: "me", cwd: "/w" };
const other: Owner = { kind: "agent", sessionId: "other", cwd: "/w", repo: "r", worktree: "wt" };
const resource: DeviceResource = { kind: "device", platform: "ios", id: UDID, name: "sim" };

let dir: string;
let store: Store;
let now: number;
let alive: boolean;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-devlease-"));
	store = openStore(join(dir, "warden.db"));
	now = 1_000_000;
	alive = false;
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const opts = (claim: boolean) => ({ now, pidAlive: () => alive, claim, label: "warden ui" });

describe("ensureCallerLease", () => {
	test("own lease: heartbeat", () => {
		const lease = store.insertLease({ resource, owner: me, ttlMs: DEFAULT_TTL_MS }, now);
		now += 5000;
		const res = ensureCallerLease(store, me, "ios", UDID, opts(false));
		expect(res.success && res.data.action).toBe("own");
		expect(store.getLease(lease.id)?.heartbeatAt).toBe(now);
	});

	test("live foreign lease: device_foreign with the hook's block message, even with claim", () => {
		store.insertLease({ resource, owner: other, ttlMs: DEFAULT_TTL_MS }, now);
		const res = ensureCallerLease(store, me, "ios", UDID, opts(true));
		expect(res).toEqual({
			success: false,
			error: { code: "device_foreign", message: blockMessage(UDID, "ios", other) },
		});
		expect(blockMessage(UDID, "ios", other)).toContain("leased by agent other (r/wt)");
	});

	test("none: device_not_leased without claim, leased with claim", () => {
		const denied = ensureCallerLease(store, me, "ios", UDID, opts(false));
		expect(!denied.success && denied.error.code).toBe("device_not_leased");
		expect(store.listLeases()).toHaveLength(0);
		const res = ensureCallerLease(store, me, "ios", UDID, opts(true));
		expect(res.success && res.data.action).toBe("leased");
		const lease = store.findLeaseByResource(resource);
		expect(lease?.label).toBe("warden ui");
		expect(lease?.owner).toEqual(me);
	});

	test("stale foreign lease: reclaimed with claim, device_not_leased without", () => {
		store.insertLease({ resource, owner: other, ttlMs: 1000 }, now);
		now += 5000;
		const denied = ensureCallerLease(store, me, "ios", UDID, opts(false));
		expect(!denied.success && denied.error.code).toBe("device_not_leased");
		expect(store.listLeases()).toHaveLength(1);
		const res = ensureCallerLease(store, me, "ios", UDID, opts(true));
		expect(res.success && res.data.action).toBe("reclaimed");
		expect(store.findLeaseByResource(resource)?.owner).toEqual(me);
	});

	test("foreign lease with a live pid stays foreign", () => {
		store.insertLease({ resource, owner: other, ttlMs: 1000, pid: 42 }, now);
		now += 5000;
		alive = true;
		const res = ensureCallerLease(store, me, "ios", UDID, opts(true));
		expect(!res.success && res.error.code).toBe("device_foreign");
	});

	describe("exclusive (warden ui): an own lease a live warden process holds", () => {
		const run = { resource, owner: me, ttlMs: DEFAULT_TTL_MS, pid: 4242, label: "warden e2e" };

		test("live run pid: device_busy naming the owner, pid and label; no heartbeat", () => {
			const lease = store.insertLease(run, now);
			now += 5000;
			alive = true;
			const res = ensureCallerLease(store, me, "ios", UDID, { ...opts(true), exclusive: true });
			expect(res).toEqual({ success: false, error: { code: "device_busy", message: busyMessage(lease) } });
			expect(busyMessage(lease)).toBe(
				`device sim (${UDID}) is in use by agent me (pid 4242, warden e2e); re-run with --force to drive it anyway`
			);
			expect(store.getLease(lease.id)?.heartbeatAt).toBe(lease.heartbeatAt);
		});

		test("dead run pid: own (heartbeat)", () => {
			store.insertLease(run, now);
			alive = false;
			const res = ensureCallerLease(store, me, "ios", UDID, { ...opts(false), exclusive: true });
			expect(res.success && res.data.action).toBe("own");
		});

		test("the caller's own liveness pid (a user's shell) is not a foreign holder", () => {
			const user: Owner = { kind: "user", pid: 77, cwd: "/w" };
			store.insertLease({ resource, owner: user, ttlMs: DEFAULT_TTL_MS, pid: 77 }, now);
			alive = true;
			const res = ensureCallerLease(store, user, "ios", UDID, { ...opts(false), exclusive: true, pid: 77 });
			expect(res.success && res.data.action).toBe("own");
		});

		test("own lease without a pid (a plain claim): own", () => {
			store.insertLease({ resource, owner: me, ttlMs: DEFAULT_TTL_MS }, now);
			alive = true;
			const res = ensureCallerLease(store, me, "ios", UDID, { ...opts(false), exclusive: true });
			expect(res.success && res.data.action).toBe("own");
		});

		test("not exclusive (the hook, --force): own, as before", () => {
			store.insertLease(run, now);
			alive = true;
			const res = ensureCallerLease(store, me, "ios", UDID, opts(false));
			expect(res.success && res.data.action).toBe("own");
		});

		test("no label: the message leaves it out", () => {
			const lease = store.insertLease({ resource, owner: me, ttlMs: DEFAULT_TTL_MS, pid: 4242 }, now);
			expect(busyMessage(lease)).toContain("(pid 4242);");
		});
	});

	test("bootedByOwner and pid land on a new lease", () => {
		ensureCallerLease(store, me, "ios", UDID, { ...opts(true), bootedByOwner: true, pid: 7 });
		const lease = store.findLeaseByResource(resource);
		expect(lease?.bootedByOwner).toBe(true);
		expect(lease?.pid).toBe(7);
	});
});

describe("releaseDevices", () => {
	test("deletes leases, touches devices, runs `after` per device lease only", async () => {
		store.recordDevice({ platform: "ios", id: UDID, name: "sim" }, 1);
		const dev = store.insertLease({ resource, owner: me, ttlMs: DEFAULT_TTL_MS }, now);
		const port = store.insertLease({ resource: { kind: "port", port: 8081 }, owner: me, ttlMs: DEFAULT_TTL_MS }, now);
		const seen: string[] = [];
		const released = await releaseDevices({ store: () => store, now: () => now }, [dev.id, port.id, "nope"], {
			after: async (udid) => {
				seen.push(udid);
			},
		});
		expect(released.map((l) => l.id)).toEqual([dev.id, port.id]);
		expect(store.listLeases()).toHaveLength(0);
		expect(seen).toEqual([UDID]);
		expect(store.listDevices()[0]?.lastUsedAt).toBe(now);
	});

	test("deletion is synchronous; touch: false leaves lastUsedAt; `after` errors never throw", async () => {
		store.recordDevice({ platform: "ios", id: UDID, name: "sim" }, 1);
		const dev = store.insertLease({ resource, owner: me, ttlMs: DEFAULT_TTL_MS }, now);
		const pending = releaseDevices({ store: () => store, now: () => now }, [dev.id], {
			touch: false,
			after: async () => {
				throw new Error("boom");
			},
		});
		expect(store.listLeases()).toHaveLength(0);
		await pending;
		expect(store.listDevices()[0]?.lastUsedAt).toBe(1);
	});
});
