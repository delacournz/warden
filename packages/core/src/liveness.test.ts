import { describe, expect, test } from "bun:test";
import { isLeaseAlive } from "./liveness";
import type { Lease } from "./types";

const base: Lease = {
	id: "l1",
	resource: { kind: "port", port: 8091 },
	owner: { kind: "user", pid: 1, cwd: "/" },
	acquiredAt: 0,
	heartbeatAt: 1_000,
	ttlMs: 500,
};

describe("isLeaseAlive", () => {
	test("fresh heartbeat without pid is alive", () => {
		expect(isLeaseAlive(base, 1_400, () => false)).toBe(true);
	});

	test("expired heartbeat without pid is dead", () => {
		expect(isLeaseAlive(base, 1_600, () => true)).toBe(false);
	});

	test("live pid keeps lease alive after heartbeat expiry", () => {
		expect(isLeaseAlive({ ...base, pid: 42 }, 10_000, (pid) => pid === 42)).toBe(true);
	});

	test("dead pid + expired heartbeat is dead", () => {
		expect(isLeaseAlive({ ...base, pid: 42 }, 10_000, () => false)).toBe(false);
	});

	test("dead pid but fresh heartbeat is alive", () => {
		expect(isLeaseAlive({ ...base, pid: 42 }, 1_200, () => false)).toBe(true);
	});

	test("heartbeat exactly at ttl boundary is alive", () => {
		expect(isLeaseAlive(base, 1_500, () => false)).toBe(true);
	});
});

describe("isLeaseAlive: supervised leases (pid + heartbeat period)", () => {
	// `warden run` / `dev` / `batch` / `e2e`: a 30 min TTL, heartbeat every 30 s, its own pid
	const supervised: Lease = { ...base, ttlMs: 30 * 60_000, pid: 42, heartbeatMs: 30_000 };
	const dead = () => false;

	test("dead pid within three heartbeat periods is alive (suspend/resume grace)", () => {
		expect(isLeaseAlive(supervised, 1_000 + 90_000, dead)).toBe(true);
	});

	test("dead pid past three heartbeat periods is dead, long before the TTL", () => {
		expect(isLeaseAlive(supervised, 1_000 + 90_001, dead)).toBe(false);
	});

	test("live pid keeps a supervised lease alive however old its heartbeat", () => {
		expect(isLeaseAlive(supervised, 1_000 + 3_600_000, (pid) => pid === 42)).toBe(true);
	});

	test("the TTL still bounds a dead pid when it is shorter than three periods", () => {
		expect(isLeaseAlive({ ...supervised, ttlMs: 500 }, 1_600, dead)).toBe(false);
	});

	test("a heartbeat period without a pid keeps the TTL rule", () => {
		const { pid: _pid, ...pidless } = supervised;
		expect(isLeaseAlive(pidless, 1_000 + 90_001, dead)).toBe(true);
		expect(isLeaseAlive(pidless, 1_000 + 30 * 60_000 + 1, () => true)).toBe(false);
	});
});
