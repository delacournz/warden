import { describe, expect, test } from "bun:test";
import { countOtherClaims, limitFor, parseOwnerLimit } from "./owner-limit";
import type { Lease, Owner, QueueEntry } from "./types";

const owner: Owner = { kind: "agent", sessionId: "s1", cwd: "/w" };

describe("parseOwnerLimit", () => {
	test("unset or blank is unlimited", () => {
		expect(parseOwnerLimit(undefined)).toEqual({ success: true, data: {} });
		expect(parseOwnerLimit("  ")).toEqual({ success: true, data: {} });
	});
	test("a plain number applies to every platform", () => {
		const parsed = parseOwnerLimit("2");
		expect(parsed.success && limitFor(parsed.data, "ios")).toBe(2);
		expect(parsed.success && limitFor(parsed.data, "android")).toBe(2);
	});
	test("per-platform list leaves the other platform unlimited", () => {
		const parsed = parseOwnerLimit("ios=2, android=1");
		expect(parsed.success && limitFor(parsed.data, "ios")).toBe(2);
		expect(parsed.success && limitFor(parsed.data, "android")).toBe(1);
		const one = parseOwnerLimit("android=3");
		expect(one.success && limitFor(one.data, "ios")).toBeUndefined();
	});
	test.each(["0", "-1", "x", "ios=", "ios=0", "tvos=1", "ios=1,ios=2", "1.5", "ios=1,"])("rejects %s", (raw) => {
		const parsed = parseOwnerLimit(raw);
		expect(parsed.success).toBe(false);
		if (!parsed.success) expect(parsed.error).toContain("WARDEN_MAX_PER_OWNER");
	});
});

const lease = (id: string, platform: "ios" | "android", claimId?: string, who: Owner = owner): Lease => ({
	id,
	resource: { kind: "device", platform, id: `d-${id}`, name: id },
	owner: who,
	acquiredAt: 1,
	heartbeatAt: 1,
	ttlMs: 1,
	...(claimId ? { claimId } : {}),
});
const row = (id: string, platform: "ios" | "android", claimId?: string, who: Owner = owner): QueueEntry => ({
	id,
	platform,
	profile: "p",
	units: 0,
	priority: 10,
	enqueuedAt: 1,
	heartbeatAt: 1,
	owner: who,
	...(claimId ? { claimId } : {}),
});

describe("countOtherClaims", () => {
	test("legs sharing a claim id count once; the asking claim's own id is excluded", () => {
		const leases = [lease("a", "ios", "c1"), lease("b", "ios", "c1"), lease("c", "ios", "c2")];
		expect(countOtherClaims({ leases, queue: [], owner, platform: "ios", claimId: "me", queueId: "q" })).toMatchObject({
			count: 2,
		});
		expect(countOtherClaims({ leases, queue: [], owner, platform: "ios", claimId: "c1", queueId: "q" }).count).toBe(1);
	});
	test("old rows without a claim id count one each; other owners and platforms never count", () => {
		const leases = [
			lease("a", "ios"),
			lease("b", "ios"),
			lease("c", "android", "c9"),
			lease("d", "ios", "c3", { kind: "agent", sessionId: "z", cwd: "/" }),
		];
		expect(countOtherClaims({ leases, queue: [], owner, platform: "ios", claimId: "me", queueId: "q" }).count).toBe(2);
	});
	test("queue rows of other claims count, own row and same claim id do not", () => {
		const queue = [row("q1", "ios", "c1"), row("q", "ios", "me"), row("q3", "ios", "c1")];
		const counted = countOtherClaims({ leases: [], queue, owner, platform: "ios", claimId: "me", queueId: "q" });
		expect(counted.count).toBe(1);
	});
	test("oldest is the owner's oldest counted lease", () => {
		const a = { ...lease("a", "ios", "c1"), acquiredAt: 5 };
		const b = { ...lease("b", "ios", "c2"), acquiredAt: 2 };
		const counted = countOtherClaims({
			leases: [a, b],
			queue: [],
			owner,
			platform: "ios",
			claimId: "me",
			queueId: "q",
		});
		expect(counted.oldest?.id).toBe("b");
	});
	test("port and build leases never count", () => {
		const port: Lease = { ...lease("p", "ios", "c1"), resource: { kind: "port", port: 8081 } };
		expect(
			countOtherClaims({ leases: [port], queue: [], owner, platform: "ios", claimId: "me", queueId: "q" }).count
		).toBe(0);
	});
});
