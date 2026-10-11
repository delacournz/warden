import { describe, expect, test } from "bun:test";
import { shouldShutdown, staleForMs, staleShutdownBlock } from "./shutdown-policy";
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
