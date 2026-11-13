import { z } from "zod";
import { TOOL_IDS, type ToolId, toolIdSchema } from "./kit";
import type { StreamMetrics } from "./stream";
import { type Baseline, successCheckSchema } from "./suite.schema";

export const REPORT_FILE = "report.json";
export const REPORT_MD = "report.md";

/**
 * How one tool's run ended. `passed` / `failed` = the agent finished and the success checks ran; `turn_limit` /
 * `timed_out` / `aborted` (Ctrl-C) = the bench stopped the agent (checks still run, but the outcome stays);
 * `agent_error` = claude exited non-zero or never produced a result.
 */
export const OUTCOMES = ["passed", "failed", "turn_limit", "timed_out", "aborted", "agent_error"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/**
 * Why a tool never ran: `unavailable` = not installed or its doctor failed; `setup_failed` = installing the app
 * or the tool's prepare failed; `not_run` = an earlier Ctrl-C stopped the run.
 */
export const SKIPS = ["unavailable", "setup_failed", "not_run"] as const;
export type Skip = (typeof SKIPS)[number];

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
	driverCalls: z.number().int(),
	driverVerbs: z.record(z.string(), z.number().int()),
	skillLoads: z.array(z.string()),
	stumbles: z.number().int(),
	errorCodes: z.record(z.string(), z.number().int()),
	assistantTurns: z.number().int(),
	result: resultSummarySchema.optional(),
	unparsedLines: z.number().int(),
});

const BASELINE_METRICS = ["toolCalls", "driverCalls", "stumbles", "wallMs"] as const;
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

const checkResultSchema = z.strictObject({ check: successCheckSchema, passed: z.boolean(), output: z.string() });

const ranSchema = z.strictObject({
	tool: toolIdSchema,
	ran: z.literal(true),
	version: z.string(),
	outcome: z.enum(OUTCOMES),
	/** the tool's own warm-up before the agent starts (server, runner, helper); not in `wallMs` */
	prepareMs: z.number(),
	/** the `claude` process only */
	wallMs: z.number(),
	exitCode: z.number().int(),
	metrics: metricsSchema,
	checks: z.array(checkResultSchema),
	diff: z.array(diffRowSchema).optional(),
	/** last lines of claude's stderr when it failed */
	stderrTail: z.string().optional(),
	notes: z.array(z.string()),
});

const skippedSchema = z.strictObject({
	tool: toolIdSchema,
	ran: z.literal(false),
	version: z.string().optional(),
	outcome: z.enum(SKIPS),
	reason: z.string(),
});

export const toolReportSchema = z.discriminatedUnion("ran", [ranSchema, skippedSchema]);
export type ToolReport = z.infer<typeof toolReportSchema>;
export type RanReport = z.infer<typeof ranSchema>;

export const reportSchema = z.strictObject({
	reportVersion: z.literal(2),
	runId: z.string(),
	suite: z.string(),
	model: z.string(),
	platform: z.enum(["ios", "android"]),
	udid: z.string(),
	startedAt: z.string(),
	tools: z.array(toolReportSchema).min(1),
});
export type AgentReport = z.infer<typeof reportSchema>;

// compile-time guard: the report's metrics are exactly what the stream parser produces
const _metricsMatch: (m: StreamMetrics) => z.infer<typeof metricsSchema> = (m) => m;
void _metricsMatch;

/** passed = every tool in the report ran and passed. */
export function allPassed(r: AgentReport): boolean {
	return r.tools.every((t) => t.outcome === "passed");
}

function actualOf(metric: BaselineMetric, metrics: StreamMetrics, wallMs: number): number {
	return metric === "wallMs" ? wallMs : metrics[metric];
}

/** One row per baseline metric; undefined when the tool has no baseline yet. */
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
	driverCalls: "driver calls",
	stumbles: "stumbles",
	wallMs: "wall",
};

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function fmt(metric: BaselineMetric, value: number): string {
	return metric === "wallMs" ? secs(value) : String(value);
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

function describeCheck(check: RanReport["checks"][number]["check"]): string {
	if ("is" in check) return `is ${check.is} ${check.state}`;
	if ("absent" in check) return `wait absent ${check.absent}`;
	return `wait ${check.wait}`;
}

const MARK: Record<ToolReport["outcome"], string> = {
	passed: "✅",
	failed: "❌",
	turn_limit: "❌",
	timed_out: "❌",
	aborted: "⏹",
	agent_error: "💥",
	unavailable: "➖",
	setup_failed: "💥",
	not_run: "➖",
};

function baselineTable(t: RanReport): string[] {
	if (t.diff === undefined) return [];
	return [
		"",
		"| vs baseline | run | baseline | Δ |",
		"|---|---|---|---|",
		...t.diff.map(
			(d) =>
				`| ${LABELS[d.metric]} | ${fmt(d.metric, d.actual)} | ${fmt(d.metric, d.baseline)} | ${signed(d.metric, d)} |`
		),
	];
}

function toolSection(t: ToolReport): string[] {
	if (!t.ran) return [`## ${t.tool} ${MARK[t.outcome]} ${t.outcome}`, "", `- ${t.reason}`, ""];
	const m = t.metrics;
	return [
		`## ${t.tool} ${MARK[t.outcome]} ${t.outcome}`,
		"",
		`- version \`${t.version}\` · prepare ${secs(t.prepareMs)} · agent ${secs(t.wallMs)} · exit ${t.exitCode}`,
		`- skills loaded: ${m.skillLoads.length === 0 ? "none" : m.skillLoads.map((s) => `\`${s}\``).join(", ")}`,
		`- tools: ${counts(m.toolsByName)}`,
		`- driver verbs: ${counts(m.driverVerbs)}`,
		`- error codes: ${counts(m.errorCodes)}`,
		...t.notes.map((n) => `- note: ${n}`),
		...baselineTable(t),
		"",
		...t.checks.map((c) => `- ${c.passed ? "✅" : "❌"} \`${describeCheck(c.check)}\``),
		...(t.stderrTail ? ["", "```", t.stderrTail, "```"] : []),
		"",
	];
}

type Row = { label: string; cell: (t: RanReport) => string; value?: (t: RanReport) => number | undefined };

const tokensIn = (t: RanReport): number | undefined => {
	const k = t.metrics.result?.tokens;
	return k === undefined ? undefined : k.input + k.cacheRead + k.cacheWrite;
};

/** Comparison rows; `value` marks the row "lower is better", and the best tool that passed is bolded. */
const ROWS: Row[] = [
	{ label: "checks", cell: (t) => `${t.checks.filter((c) => c.passed).length}/${t.checks.length}` },
	{ label: "agent wall", cell: (t) => secs(t.wallMs), value: (t) => t.wallMs },
	{ label: "prepare", cell: (t) => secs(t.prepareMs) },
	{ label: "turns", cell: (t) => String(t.metrics.assistantTurns), value: (t) => t.metrics.assistantTurns },
	{ label: "tool calls", cell: (t) => String(t.metrics.toolCalls), value: (t) => t.metrics.toolCalls },
	{ label: "driver calls", cell: (t) => String(t.metrics.driverCalls), value: (t) => t.metrics.driverCalls },
	{ label: "stumbles", cell: (t) => String(t.metrics.stumbles), value: (t) => t.metrics.stumbles },
	{
		label: "cost",
		cell: (t) => (t.metrics.result === undefined ? "n/a" : `$${t.metrics.result.costUsd.toFixed(2)}`),
		value: (t) => t.metrics.result?.costUsd,
	},
	{
		label: "tokens in",
		cell: (t) => {
			const v = tokensIn(t);
			return v === undefined ? "n/a" : v.toLocaleString("en-US");
		},
		value: tokensIn,
	},
	{
		label: "tokens out",
		cell: (t) => t.metrics.result?.tokens.output.toLocaleString("en-US") ?? "n/a",
		value: (t) => t.metrics.result?.tokens.output,
	},
	{ label: "version", cell: (t) => `\`${t.version}\`` },
];

function comparisonRow(row: Row, tools: readonly ToolReport[]): string {
	const passed = tools.filter((t): t is RanReport => t.ran && t.outcome === "passed");
	const values = row.value === undefined ? [] : passed.map(row.value).filter((v) => v !== undefined);
	const best = passed.length > 1 && values.length > 0 ? Math.min(...values) : undefined;
	const cells = tools.map((t) => {
		if (!t.ran) return "—";
		const cell = row.cell(t);
		const v = row.value?.(t);
		return best !== undefined && t.outcome === "passed" && v === best ? `**${cell}**` : cell;
	});
	return `| ${row.label} | ${cells.join(" | ")} |`;
}

/** The side-by-side table that ends the report: one column per tool, best passing value in bold. */
export function renderComparison(r: AgentReport): string[] {
	const tools = [...r.tools].sort((a, b) => TOOL_IDS.indexOf(a.tool) - TOOL_IDS.indexOf(b.tool));
	const head = tools.map((t) => t.tool);
	return [
		`| | ${head.join(" | ")} |`,
		`|---|${head.map(() => "---").join("|")}|`,
		`| outcome | ${tools.map((t) => `${MARK[t.outcome]} ${t.outcome}`).join(" | ")} |`,
		...ROWS.map((row) => comparisonRow(row, tools)),
	];
}

const toolName = (id: ToolId): string => `\`${id}\``;

/** The human summary written next to `report.json`; the comparison table comes last. */
export function renderMarkdown(r: AgentReport): string {
	return [
		`# agent bench: ${r.suite} — ${allPassed(r) ? "all passed" : "not all passed"}`,
		"",
		`Run \`${r.runId}\` · model \`${r.model}\` · ${r.platform} \`${r.udid}\` · started ${r.startedAt} · tools ${r.tools.map((t) => toolName(t.tool)).join(", ")}`,
		"",
		...r.tools.flatMap(toolSection),
		"## Comparison",
		"",
		...renderComparison(r),
		"",
		"Same model, prompt task, device and pinned app for every tool; each starts from a fresh install. Bold = best among tools that passed (lower is better). Driver calls = calls to the tool under test (its CLI via Bash, or its MCP tools). Checks run through `warden ui` after the tool's own helpers are stopped.",
		"",
	].join("\n");
}
