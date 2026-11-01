/** The capture switches `device.perf.start` takes (the `warden perf start` flags of the same name). */
export type PerfStartOptions = {
	js?: boolean;
	react?: boolean;
	native?: boolean | "perfetto" | "simpleperf";
	metrics?: boolean;
	frames?: boolean;
	logs?: boolean;
	all?: boolean;
	/** stop the app, arm the captures, launch it: startup and early JS/React are recorded */
	relaunch?: boolean;
	/** like `relaunch`, but wipe the app's data first */
	reset?: boolean;
	/** hard cap on the session; warden's default is 30 s, the maximum 5 min */
	maxDurationMs?: number;
};

/** The numbers of a report, each lower-is-better (the `metrics` of `report.json`). */
export type PerfMetrics = {
	startupColdMs?: number;
	startupWarmMs?: number;
	jankPct?: number;
	fps?: number;
	cpuP95Pct?: number;
	peakPssKb?: number;
	peakRssKb?: number;
	/** the slowest React commit */
	topCommitMs?: number;
	hangCount?: number;
	hangTotalMs?: number;
	topFunctions: Array<{ name: string; selfPct: number }>;
};

/** `report.json` of a perf session, as far as a spec reads it (the full document is at `reportPath`). */
export type PerfReport = {
	version: 1;
	sessionId: string;
	app?: string;
	durationMs: number;
	stopReason?: string;
	banners: string[];
	summary: string[];
	findings: Array<{ kind: string; severity: string; costMs: number; evidence: string; fix: string }>;
	metrics: PerfMetrics;
	marks: Array<{ label: string; atMs: number }>;
	next: string[];
	/** where `report.json` is (inside the attempt's `perf/` dir when the spec runs under `warden e2e`) */
	reportPath?: string;
};
