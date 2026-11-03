import { describe, expect, test } from "bun:test";
import type { LeaseEvent } from "./lease-events";
import { computeLeaseStats, peakOverlap, percentile } from "./lease-stats";

let id = 0;
const requested = (at: number, claimId: string): LeaseEvent => ({
	id: ++id,
	at,
	type: "requested",
	claimId,
	data: { platform: "ios", profile: "iphone-17", count: 1 },
});
const granted = (
	at: number,
	leaseId: string,
	waitMs: number,
	profile = "iphone-17",
	platform: "ios" | "android" = "ios"
) =>
	({
		id: ++id,
		at,
		type: "granted",
		leaseId,
		data: { platform, profile, deviceId: leaseId, deviceName: leaseId, action: "reuse", waitMs },
	}) satisfies LeaseEvent;
const ended = (at: number, leaseId: string, type: "released" | "expired" = "released"): LeaseEvent => ({
	id: ++id,
	at,
	type,
	leaseId,
	data: { heldMs: 0 },
});

describe("lease stats", () => {
	test("nearest-rank percentiles", () => {
		const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
		expect(percentile(s, 50)).toBe(5);
		expect(percentile(s, 95)).toBe(10);
		expect(percentile([7], 95)).toBe(7);
		expect(percentile([], 50)).toBe(0);
	});

	test("peak overlap: touching intervals do not overlap", () => {
		expect(peakOverlap([])).toBe(0);
		expect(
			peakOverlap([
				{ start: 0, end: 10 },
				{ start: 10, end: 20 },
			])
		).toBe(1);
		expect(
			peakOverlap([
				{ start: 0, end: 10 },
				{ start: 5, end: 20 },
				{ start: 6, end: 7 },
			])
		).toBe(3);
	});

	test("claims, wait and duration spreads, peak concurrency per profile", () => {
		const events: LeaseEvent[] = [
			requested(0, "c1"),
			granted(1_000, "a", 1_000),
			requested(0, "c2"),
			granted(3_000, "b", 3_000),
			requested(0, "c3"),
			granted(5_000, "c", 5_000, "pixel-9", "android"),
			ended(11_000, "a"),
			ended(13_000, "b", "expired"),
		];
		const stats = computeLeaseStats(events, 20_000);
		expect(stats.claims).toBe(3);
		expect(stats.wait).toEqual({ count: 3, medianMs: 3_000, p95Ms: 5_000 });
		expect(stats.duration).toEqual({ count: 2, medianMs: 10_000, p95Ms: 10_000 });
		expect(stats.peakConcurrency).toBe(3);
		expect(stats.profiles).toEqual([
			{ platform: "android", profile: "pixel-9", grants: 1, peakConcurrency: 1 },
			{ platform: "ios", profile: "iphone-17", grants: 2, peakConcurrency: 2 },
		]);
	});

	test("a wrapper's legs (one claim id) are one claim; no events is all zeros", () => {
		const stats = computeLeaseStats([requested(0, "w"), requested(0, "w")], 1);
		expect(stats.claims).toBe(1);
		expect(computeLeaseStats([], 1)).toMatchObject({ claims: 0, wait: { count: 0 }, profiles: [] });
	});
});
