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
