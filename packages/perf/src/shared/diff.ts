import type { PerfReportJson, ReportMetrics } from "./report";

export const DEFAULT_THRESHOLD_PCT = 10;

type ScalarKey = Exclude<keyof ReportMetrics, "topFunctions">;

type MetricSpec = {
	key: ScalarKey;
	label: string;
	unit: "ms" | "%" | "KB" | "count";
	/** below this absolute change a relative jump is noise (0 to 0.4% jank, 3 to 5 ms) */
	minAbs: number;
	/** higher is better (fps): a drop is the regression */
	higherIsBetter?: true;
};

const SPECS: readonly MetricSpec[] = [
	{ key: "startupColdMs", label: "startup cold p50", unit: "ms", minAbs: 50 },
	{ key: "startupWarmMs", label: "startup warm p50", unit: "ms", minAbs: 50 },
	{ key: "jankPct", label: "jank", unit: "%", minAbs: 0.5 },
	{ key: "fps", label: "fps", unit: "count", minAbs: 2, higherIsBetter: true },
	{ key: "cpuP95Pct", label: "cpu p95", unit: "%", minAbs: 2 },
	{ key: "peakPssKb", label: "peak PSS", unit: "KB", minAbs: 2048 },
	{ key: "peakRssKb", label: "peak RSS", unit: "KB", minAbs: 2048 },
	{ key: "topCommitMs", label: "slowest commit", unit: "ms", minAbs: 8 },
	{ key: "hangCount", label: "hangs", unit: "count", minAbs: 1 },
	{ key: "hangTotalMs", label: "hang time", unit: "ms", minAbs: 100 },
];

export type MetricDelta = {
	kind: "metric";
	key: ScalarKey;
	label: string;
	unit: MetricSpec["unit"];
	before: number;
	after: number;
	delta: number;
	/** change relative to `before` (undefined when `before` is 0) */
	pct?: number;
	verdict: "regress" | "improve" | "same";
};

export type FunctionDelta = {
	kind: "function";
	name: string;
	before: number;
	after: number;
	/** self-percentage points */
	delta: number;
	verdict: "regress" | "improve" | "same" | "new";
};

export type ReportDiff = {
	a: string;
	b: string;
	thresholdPct: number;
	metrics: MetricDelta[];
	functions: FunctionDelta[];
	regressions: number;
	improvements: number;
};

const round = (n: number, digits = 1): number => Math.round(n * 10 ** digits) / 10 ** digits;

function judge(spec: MetricSpec, before: number, after: number, thresholdPct: number): MetricDelta["verdict"] {
	const worse = spec.higherIsBetter === true ? before - after : after - before;
	const moved = Math.abs(after - before);
	if (moved < spec.minAbs) return "same";
	const pct = before === 0 ? Number.POSITIVE_INFINITY : (moved / Math.abs(before)) * 100;
	if (pct < thresholdPct) return "same";
	return worse > 0 ? "regress" : "improve";
}

/** Functions whose self share moved by at least this many percentage points are listed. */
const FUNCTION_MIN_POINTS = 2;

function diffFunctions(a: ReportMetrics, b: ReportMetrics, thresholdPct: number): FunctionDelta[] {
	const before = new Map(a.topFunctions.map((f) => [f.name, f.selfPct]));
	const after = new Map(b.topFunctions.map((f) => [f.name, f.selfPct]));
	const names = new Set([...before.keys(), ...after.keys()]);
	const out: FunctionDelta[] = [];
	for (const name of names) {
		const x = before.get(name) ?? 0;
		const y = after.get(name) ?? 0;
		const delta = round(y - x);
		if (Math.abs(delta) < FUNCTION_MIN_POINTS) continue;
		const relative = x === 0 ? Number.POSITIVE_INFINITY : (Math.abs(delta) / x) * 100;
		const verdict: FunctionDelta["verdict"] =
			relative < thresholdPct ? "same" : delta > 0 ? (x === 0 ? "new" : "regress") : "improve";
		out.push({ kind: "function", name, before: x, after: y, delta, verdict });
	}
	return out.sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta)).slice(0, 10);
}

/** Per-metric deltas of two session reports with a regression verdict past `thresholdPct`. Metrics only one side has are skipped. */
export function diffReports(
	a: Pick<PerfReportJson, "sessionId" | "metrics">,
	b: Pick<PerfReportJson, "sessionId" | "metrics">,
	thresholdPct: number = DEFAULT_THRESHOLD_PCT
): ReportDiff {
	const metrics: MetricDelta[] = [];
	for (const spec of SPECS) {
		const before = a.metrics[spec.key];
		const after = b.metrics[spec.key];
		if (before === undefined || after === undefined) continue;
		metrics.push({
			kind: "metric",
			key: spec.key,
			label: spec.label,
			unit: spec.unit,
			before,
			after,
			delta: round(after - before, 2),
			...(before === 0 ? {} : { pct: round(((after - before) / Math.abs(before)) * 100) }),
			verdict: judge(spec, before, after, thresholdPct),
		});
	}
	const functions = diffFunctions(a.metrics, b.metrics, thresholdPct);
	const all = [...metrics, ...functions];
	return {
		a: a.sessionId,
		b: b.sessionId,
		thresholdPct,
		metrics,
		functions,
		regressions: all.filter((d) => d.verdict === "regress" || d.verdict === "new").length,
		improvements: all.filter((d) => d.verdict === "improve").length,
	};
}

const UNIT: Record<MetricSpec["unit"], string> = { ms: "ms", "%": "%", KB: "KB", count: "" };

/** `startup cold p50  1200ms -> 1500ms  +300ms (+25%)  REGRESS` */
export function diffLines(diff: ReportDiff): string[] {
	const lines = [`diff ${diff.a} -> ${diff.b} (threshold ${diff.thresholdPct}%)`];
	for (const m of diff.metrics) {
		const u = UNIT[m.unit];
		const sign = m.delta > 0 ? "+" : "";
		const pct = m.pct === undefined ? "" : ` (${m.pct > 0 ? "+" : ""}${m.pct}%)`;
		lines.push(
			`${m.label.padEnd(18)} ${m.before}${u} -> ${m.after}${u}  ${sign}${m.delta}${u}${pct}  ${m.verdict === "same" ? "" : m.verdict.toUpperCase()}`.trimEnd()
		);
	}
	for (const f of diff.functions) {
		const sign = f.delta > 0 ? "+" : "";
		lines.push(
			`fn ${f.name}  ${f.before}% -> ${f.after}% self  ${sign}${f.delta}pt  ${f.verdict === "same" ? "" : f.verdict.toUpperCase()}`.trimEnd()
		);
	}
	lines.push(
		`${diff.regressions} regression${diff.regressions === 1 ? "" : "s"}, ${diff.improvements} improvement${diff.improvements === 1 ? "" : "s"}`
	);
	return lines;
}
