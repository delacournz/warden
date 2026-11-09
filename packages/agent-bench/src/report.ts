import { z } from "zod";
import type { StreamMetrics } from "./stream";
import { type Baseline, successCheckSchema } from "./suite.schema";

export const REPORT_FILE = "report.json";
export const REPORT_MD = "report.md";

/**
 * How the run ended. `passed` / `failed` = the agent finished and the success checks ran; `turn_limit` /
 * `timed_out` / `aborted` (Ctrl-C) = the bench stopped the agent (checks still run, but the outcome stays); `agent_error` = claude
 * exited non-zero or never produced a result.
 */
export const OUTCOMES = ["passed", "failed", "turn_limit", "timed_out", "aborted", "agent_error"] as const;
export type Outcome = (typeof OUTCOMES)[number];

const resultSummarySchema = z.strictObject({
	subtype: z.string(),
	isError: z.boolean(),
	numTurns: z.number(),
	costUsd: z.number(),
	durationMs: z.number(),
	tokens: z.strictObject({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() }),
});

const metricsSchema = z.strictObject({
	model: z.string().optional(),
	toolCalls: z.number().int(),
	toolsByName: z.record(z.string(), z.number().int()),
	wardenCalls: z.number().int(),
	wardenUiCalls: z.number().int(),
	wardenVerbs: z.record(z.string(), z.number().int()),
	skillLoads: z.array(z.string()),
	stumbles: z.number().int(),
	errorCodes: z.record(z.string(), z.number().int()),
	assistantTurns: z.number().int(),
	result: resultSummarySchema.optional(),
	unparsedLines: z.number().int(),
});

const BASELINE_METRICS = ["toolCalls", "wardenCalls", "stumbles", "wallMs"] as const;
type BaselineMetric = (typeof BASELINE_METRICS)[number];

const diffRowSchema = z.strictObject({
	metric: z.enum(BASELINE_METRICS),
	baseline: z.number(),
	actual: z.number(),
	delta: z.number(),
	/** absent when the baseline is 0 */
	pct: z.number().optional(),
});
export type DiffRow = z.infer<typeof diffRowSchema>;

export const reportSchema = z.strictObject({
	reportVersion: z.literal(1),
	runId: z.string(),
	suite: z.string(),
	model: z.string(),
	platform: z.enum(["ios", "android"]),
	udid: z.string(),
	startedAt: z.string(),
	wallMs: z.number(),
	outcome: z.enum(OUTCOMES),
	exitCode: z.number().int(),
	metrics: metricsSchema,
	checks: z.array(z.strictObject({ check: successCheckSchema, passed: z.boolean(), output: z.string() })),
	diff: z.array(diffRowSchema).optional(),
	/** last lines of claude's stderr when it failed */
	stderrTail: z.string().optional(),
});
export type AgentReport = z.infer<typeof reportSchema>;

// compile-time guard: the report's metrics are exactly what the stream parser produces
const _metricsMatch: (m: StreamMetrics) => z.infer<typeof metricsSchema> = (m) => m;
void _metricsMatch;

function actualOf(metric: BaselineMetric, metrics: StreamMetrics, wallMs: number): number {
	return metric === "wallMs" ? wallMs : metrics[metric];
}

/** One row per baseline metric; undefined when the suite has no baseline yet. */
export function diffBaseline(
	baseline: Baseline | undefined,
	metrics: StreamMetrics,
	wallMs: number
): DiffRow[] | undefined {
	if (baseline === undefined) return undefined;
	return BASELINE_METRICS.map((metric) => {
		const base = baseline[metric];
		const actual = actualOf(metric, metrics, wallMs);
		const delta = actual - base;
		return base === 0
			? { metric, baseline: base, actual, delta }
			: { metric, baseline: base, actual, delta, pct: Math.round((delta / base) * 1000) / 10 };
	});
}

const LABELS: Record<BaselineMetric, string> = {
	toolCalls: "tool calls",
	wardenCalls: "warden calls",
	stumbles: "stumbles",
	wallMs: "wall",
};

function fmt(metric: BaselineMetric, value: number): string {
	return metric === "wallMs" ? `${(value / 1000).toFixed(1)} s` : String(value);
}

function signed(metric: BaselineMetric, row: DiffRow): string {
	const sign = row.delta > 0 ? "+" : row.delta < 0 ? "-" : "";
	const abs = fmt(metric, Math.abs(row.delta));
	const pct = row.pct === undefined ? "" : ` (${row.pct > 0 ? "+" : ""}${row.pct}%)`;
	return `${sign}${abs}${pct}`;
}

function counts(record: Record<string, number>): string {
	const entries = Object.entries(record).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return entries.length === 0 ? "none" : entries.map(([k, v]) => `\`${k}\` ${v}`).join(", ");
}

function describeCheck(check: AgentReport["checks"][number]["check"]): string {
	if ("is" in check) return `is ${check.is} ${check.state}`;
	if ("absent" in check) return `wait absent ${check.absent}`;
	return `wait ${check.wait}`;
}

/** The human summary written next to `report.json`. */
export function renderMarkdown(r: AgentReport): string {
	const m = r.metrics;
	const rows: [BaselineMetric, number][] = BASELINE_METRICS.map((k) => [k, actualOf(k, m, r.wallMs)]);
	const table =
		r.diff === undefined
			? ["| metric | run |", "|---|---|", ...rows.map(([k, v]) => `| ${LABELS[k]} | ${fmt(k, v)} |`)]
			: [
					"| metric | run | baseline | Δ |",
					"|---|---|---|---|",
					...r.diff.map(
						(d) =>
							`| ${LABELS[d.metric]} | ${fmt(d.metric, d.actual)} | ${fmt(d.metric, d.baseline)} | ${signed(d.metric, d)} |`
					),
				];
	const cost = m.result === undefined ? "n/a" : `$${m.result.costUsd.toFixed(2)}`;
	return [
		`# agent bench: ${r.suite} — ${r.outcome}`,
		"",
		`Run \`${r.runId}\` · model \`${r.model}\` · ${r.platform} \`${r.udid}\` · started ${r.startedAt}`,
		"",
		...table,
		"",
		`- turns: ${m.assistantTurns} · cost: ${cost} · \`warden ui\` calls: ${m.wardenUiCalls}`,
		`- skills loaded: ${m.skillLoads.length === 0 ? "none" : m.skillLoads.map((s) => `\`${s}\``).join(", ")}`,
		`- tools: ${counts(m.toolsByName)}`,
		`- warden verbs: ${counts(m.wardenVerbs)}`,
		`- error codes: ${counts(m.errorCodes)}`,
		"",
		"## Success checks",
		"",
		...r.checks.map((c) => `- ${c.passed ? "✅" : "❌"} \`${describeCheck(c.check)}\``),
		...(r.stderrTail ? ["", "## claude stderr (tail)", "", "```", r.stderrTail, "```"] : []),
		"",
	].join("\n");
}
