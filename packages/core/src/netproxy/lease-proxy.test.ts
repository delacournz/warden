import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeConditions } from "../conditions/conditions";
import { processAlive } from "../liveness";
import { openStore, type Store } from "../store";
import type { Owner } from "../types";
import { getProxyStatus } from "./control";
import { handlePath } from "./handle-file";
import { ensureLeaseProxy, type LeaseProxyDeps, releaseLeaseProxy } from "./lease-proxy";

const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/tmp" };

let dir: string;
let store: Store;
let leaseId: string;
let deps: LeaseProxyDeps;
const spawned: number[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-netproxy-"));
	store = openStore(join(dir, "warden.db"));
	leaseId = store.insertLease(
		{ resource: { kind: "device", platform: "android", id: "emulator-5554", name: "emu" }, owner, ttlMs: 60_000 },
		Date.now()
	).id;
	deps = { store, env: { WARDEN_HOME: dir }, now: Date.now };
});

afterEach(async () => {
	await releaseLeaseProxy(deps, leaseId);
	for (const pid of spawned.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone
		}
	}
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const lease = () => ({ id: leaseId, owner, ttlMs: 60_000 });

describe("ensureLeaseProxy", () => {
	test("spawns a detached proxy, claims its port, records the pid for undo", async () => {
		const result = await ensureLeaseProxy(deps, lease(), {
			condition: { kind: "preset", preset: "3g" },
			conditions: { params: { latencyMs: 10 }, faults: [] },
		});
		if (!result.success) throw new Error(result.error);
		spawned.push(result.data.handle.pid);
		const { handle, portLeaseId } = result.data;
		expect(result.data.reused).toBe(false);
		expect(processAlive(handle.pid)).toBe(true);
		expect(handle.pid).not.toBe(process.pid);

		const portLease = store.getLease(portLeaseId);
		expect(portLease?.resource).toEqual({ kind: "port", port: handle.port });
		expect(portLease?.pid).toBe(handle.pid);

		const [record] = activeConditions(store, leaseId);
		expect(record?.area).toBe("network");
		expect(record?.owned).toEqual([{ kind: "pid", pid: handle.pid }]);

		const status = await getProxyStatus(handle);
		expect(status.success && status.data.params.latencyMs).toBe(10);
		expect(statSync(handlePath(leaseId, deps.env)).mode & 0o077).toBe(0);
	});

	test("a second call reuses the proxy and reconfigures it live", async () => {
		const first = await ensureLeaseProxy(deps, lease(), {
			condition: { kind: "custom", latencyMs: 10 },
			conditions: { params: { latencyMs: 10 }, faults: [] },
		});
		if (!first.success) throw new Error(first.error);
		spawned.push(first.data.handle.pid);
		const second = await ensureLeaseProxy(deps, lease(), {
			condition: { kind: "offline" },
			conditions: { params: { offline: "refuse" }, faults: [] },
		});
		if (!second.success) throw new Error(second.error);
		expect(second.data.reused).toBe(true);
		expect(second.data.handle.pid).toBe(first.data.handle.pid);
		expect(second.data.handle.port).toBe(first.data.handle.port);
		const status = await getProxyStatus(second.data.handle);
		expect(status.success && status.data.params.offline).toBe("refuse");
		expect(activeConditions(store, leaseId)[0]?.value).toEqual({ kind: "offline" });
	});

	test("release stops the process and frees the port lease", async () => {
		const result = await ensureLeaseProxy(deps, lease(), {
			condition: { kind: "online" },
			conditions: { params: {}, faults: [] },
		});
		if (!result.success) throw new Error(result.error);
		const { handle, portLeaseId } = result.data;
		spawned.push(handle.pid);
		expect(await releaseLeaseProxy(deps, leaseId)).toBe(true);
		for (let i = 0; i < 40 && processAlive(handle.pid); i++) await Bun.sleep(25);
		expect(processAlive(handle.pid)).toBe(false);
		expect(store.getLease(portLeaseId)).toBeUndefined();
		expect(existsSync(handlePath(leaseId, deps.env))).toBe(false);
		expect(await releaseLeaseProxy(deps, leaseId)).toBe(false);
	});

	test("a proxy that never starts fails cleanly and frees the port", async () => {
		const result = await ensureLeaseProxy(
			{ ...deps, spawn: () => process.pid + 100_000, readyTimeoutMs: 200, pidAlive: () => false, kill: () => {} },
			lease(),
			{ condition: { kind: "online" }, conditions: { params: {}, faults: [] } }
		);
		expect(result.success).toBe(false);
		expect(store.listLeases().filter((l) => l.resource.kind === "port")).toHaveLength(0);
	});
});
