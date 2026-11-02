import { formatDuration, parseDuration } from "@delacour/warden-core/duration";
import { computeLeaseStats, type LeaseStats } from "@delacour/warden-core/lease-stats";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit, reportError, table } from "../output";

export const DEFAULT_STATS_SINCE = "7d";

type StatsOpts = { since?: string; json?: true; csv?: true };

/** `scope,platform,profile,metric,value`: every figure on its own row, durations in ms. */
export function statsCsv(stats: LeaseStats): string {
	const rows: Array<[string, string, string, string, number]> = [
		["all", "", "", "claims", stats.claims],
		["all", "", "", "wait_count", stats.wait.count],
		["all", "", "", "wait_median_ms", stats.wait.medianMs],
		["all", "", "", "wait_p95_ms", stats.wait.p95Ms],
		["all", "", "", "duration_count", stats.duration.count],
		["all", "", "", "duration_median_ms", stats.duration.medianMs],
		["all", "", "", "duration_p95_ms", stats.duration.p95Ms],
		["all", "", "", "peak_concurrency", stats.peakConcurrency],
		...stats.profiles.flatMap(
			(p): Array<[string, string, string, string, number]> => [
				["profile", p.platform, p.profile, "grants", p.grants],
				["profile", p.platform, p.profile, "peak_concurrency", p.peakConcurrency],
			]
		),
	];
	return ["scope,platform,profile,metric,value", ...rows.map((r) => r.join(","))].join("\n");
}

function statsText(ctx: CommandContext, stats: LeaseStats): string {
	const spread = (s: LeaseStats["wait"]) =>
		s.count === 0 ? "-" : `median ${formatDuration(s.medianMs)}, p95 ${formatDuration(s.p95Ms)} (${s.count})`;
	const lines = [
		`claims            ${stats.claims}`,
		`wait              ${spread(stats.wait)}`,
		`lease duration    ${spread(stats.duration)}`,
		`peak concurrency  ${stats.peakConcurrency}`,
	];
	if (stats.profiles.length === 0) return lines.join("\n");
	const profiles = table(
		ctx,
		["PLATFORM", "PROFILE", "GRANTS", "PEAK"],
		stats.profiles.map((p) => [p.platform, p.profile, String(p.grants), String(p.peakConcurrency)])
	);
	return `${lines.join("\n")}\n\n${profiles}`;
}

/** `warden stats`: claim waits, lease durations and peak concurrency from the lease event log. */
export function runStats(ctx: CommandContext, opts: StatsOpts): number {
	if (opts.json && opts.csv) {
		reportError(ctx, "stats", "--json and --csv are mutually exclusive");
		return 1;
	}
	const since = parseDuration(opts.since ?? DEFAULT_STATS_SINCE);
	if (!since.success) {
		reportError(ctx, "stats", `--since: ${since.error}`);
		return 1;
	}
	const now = ctx.now();
	const stats = computeLeaseStats(ctx.store().listEvents({ since: now - since.data }), now);
	if (opts.csv) ctx.out(statsCsv(stats));
	else
		emit(ctx, opts.json === true, { since: opts.since ?? DEFAULT_STATS_SINCE, ...stats }, statsText(ctx, stats), {
			scope: "stats",
			detail: `last ${opts.since ?? DEFAULT_STATS_SINCE}`,
		});
	return 0;
}

export const statsCommand = defineCommand({
	name: "stats",
	group: "Lease",
	summary: "claim wait (median, p95), lease durations and peak concurrency per profile, from the lease history",
	register: (cmd, ctx, done) => {
		cmd
			.option("--since <duration>", `window, e.g. 24h (default ${DEFAULT_STATS_SINCE})`)
			.option("--json", "machine-readable output")
			.option("--csv", "CSV rows (scope,platform,profile,metric,value); not with --json")
			.action((opts) => done(runStats(ctx, opts)));
	},
});
