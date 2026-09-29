import { describe, expect, test } from "bun:test";
import { shouldShutdown } from "./shutdown-policy";
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
