import type { LeaseEvent } from "./lease-events";
import type { Platform } from "./types";

export type Spread = { count: number; medianMs: number; p95Ms: number };

export type ProfileStats = {
	platform: Platform;
	profile: string;
	grants: number;
	/** most leases of this platform+profile held at once within the window */
	peakConcurrency: number;
};

export type LeaseStats = {
	/** distinct claims (by claim id) requested in the window */
	claims: number;
	/** requested → granted, one sample per granted device */
	wait: Spread;
	/** granted → released / expired, per lease that ended in the window */
	duration: Spread;
	profiles: ProfileStats[];
	peakConcurrency: number;
};

/** Nearest-rank percentile of `sorted` (ascending); 0 for none. */
export function percentile(sorted: readonly number[], p: number): number {
	if (sorted.length === 0) return 0;
	const rank = Math.ceil((p / 100) * sorted.length);
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

function spread(samples: number[]): Spread {
	const sorted = [...samples].sort((a, b) => a - b);
	return { count: sorted.length, medianMs: percentile(sorted, 50), p95Ms: percentile(sorted, 95) };
}

type Interval = { start: number; end: number };

/** Largest number of overlapping intervals (an end at the instant of a start frees its slot first). */
export function peakOverlap(intervals: readonly Interval[]): number {
	const points = intervals.flatMap((i) => [
		{ at: i.start, delta: 1 },
		{ at: i.end, delta: -1 },
	]);
	points.sort((a, b) => a.at - b.at || a.delta - b.delta);
	let live = 0;
	let peak = 0;
	for (const p of points) {
		live += p.delta;
		peak = Math.max(peak, live);
	}
	return peak;
}

/**
 * Pure statistics over an event list. A lease still held at `now` counts as running until `now` for
 * concurrency (not for durations); a lease whose grant is outside the list is ignored.
 */
export function computeLeaseStats(events: readonly LeaseEvent[], now: number): LeaseStats {
	const claimIds = new Set<string>();
	const waits: number[] = [];
	const durations: number[] = [];
	const grants = new Map<string, { at: number; platform: Platform; profile: string }>();
	const ends = new Map<string, number>();
	for (const e of events) {
		if (e.type === "requested") claimIds.add(e.claimId ?? `event:${e.id}`);
		else if (e.type === "granted") {
			waits.push(e.data.waitMs);
			if (e.leaseId !== undefined) {
				grants.set(e.leaseId, { at: e.at, platform: e.data.platform, profile: e.data.profile ?? "unknown" });
			}
		} else if ((e.type === "released" || e.type === "expired") && e.leaseId !== undefined) {
			ends.set(e.leaseId, e.at);
		}
	}
	const intervals = new Map<string, Interval[]>();
	const all: Interval[] = [];
	const grantCount = new Map<string, number>();
	for (const [leaseId, grant] of grants) {
		const end = ends.get(leaseId);
		if (end !== undefined) durations.push(end - grant.at);
		const interval = { start: grant.at, end: end ?? now };
		all.push(interval);
		const key = `${grant.platform}\u0000${grant.profile}`;
		intervals.set(key, [...(intervals.get(key) ?? []), interval]);
		grantCount.set(key, (grantCount.get(key) ?? 0) + 1);
	}
	const profiles = [...intervals.entries()]
		.map(([key, list]): ProfileStats => {
			const [platform = "ios", profile = ""] = key.split("\u0000");
			return {
				platform: platform as Platform,
				profile,
				grants: grantCount.get(key) ?? 0,
				peakConcurrency: peakOverlap(list),
			};
		})
		.sort((a, b) => a.platform.localeCompare(b.platform) || a.profile.localeCompare(b.profile));
	return {
		claims: claimIds.size,
		wait: spread(waits),
		duration: spread(durations),
		profiles,
		peakConcurrency: peakOverlap(all),
	};
}
