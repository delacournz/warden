import type { Commit } from "../react.types";
import { FRAME_BUDGET_MS, HOT_COMMIT_MS } from "./thresholds";

export type CommitTier = "ok" | "warm" | "hot";

export type HotCommit = {
	index: number;
	startMs: number;
	wallMs: number;
	durationMs: number;
	tier: Exclude<CommitTier, "ok">;
	/** cube root of duration over the slowest commit: spreads the many mid-sized commits instead of letting one outlier flatten them */
	heat: number;
	/** the components that spent the most self time in it */
	top: Array<{ name: string; selfMs: number; count: number }>;
	/** what sat on the commit: a first mount, or the update's cause */
	mountCount: number;
	updaters: string[];
};

/** Absolute floor first: under 16ms is fine whatever the rest look like. */
export function tierOf(durationMs: number): CommitTier {
	if (durationMs < FRAME_BUDGET_MS) return "ok";
	return durationMs > HOT_COMMIT_MS ? "hot" : "warm";
}

function topComponents(commit: Commit, limit: number): HotCommit["top"] {
	const byName = new Map<string, { name: string; selfMs: number; count: number }>();
	for (const f of commit.fibers) {
		const entry = byName.get(f.name) ?? { name: f.name, selfMs: 0, count: 0 };
		entry.selfMs += f.selfMs;
		entry.count += 1;
		byName.set(f.name, entry);
	}
	return [...byName.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, limit);
}

/** Warm and hot commits, slowest first, each with its heat and the components that filled it. */
export function hotCommits(commits: readonly Commit[]): HotCommit[] {
	const max = commits.reduce((m, c) => Math.max(m, c.durationMs), 0);
	const hot: HotCommit[] = [];
	for (const c of commits) {
		const tier = tierOf(c.durationMs);
		if (tier === "ok") continue;
		hot.push({
			index: c.index,
			startMs: c.startMs,
			wallMs: c.wallMs,
			durationMs: c.durationMs,
			tier,
			heat: max > 0 ? Math.cbrt(c.durationMs / max) : 0,
			top: topComponents(c, 3),
			mountCount: c.fibers.filter((f) => f.causes?.firstMount === true).length,
			updaters: c.updaters,
		});
	}
	return hot.sort((a, b) => b.durationMs - a.durationMs);
}
