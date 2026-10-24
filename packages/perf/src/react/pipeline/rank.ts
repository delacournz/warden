import type { ComponentStat } from "./reduce";
import { RANK_MIN_MAX_MS, RANK_MIN_RENDERS } from "./thresholds";

/** Worth looking at: rendered often, or once and slowly. Costliest (sum of self time) first. */
export function rankComponents(stats: readonly ComponentStat[]): ComponentStat[] {
	return stats
		.filter((s) => s.renders >= RANK_MIN_RENDERS || s.maxSelfMs >= RANK_MIN_MAX_MS)
		.sort((a, b) => b.sumSelfMs - a.sumSelfMs || b.renders - a.renders);
}
