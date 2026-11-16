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

const repSchema = z.number().int().positive();

const ranSchema = z.strictObject({
	tool: toolIdSchema,
	/** 1-based; with `--reps`, each tool runs once per rep */
	rep: repSchema,
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
	/** absent for a tool that could not run at all (`unavailable` before the device was claimed) */
	rep: repSchema.optional(),
	ran: z.literal(false),
	version: z.string().optional(),
	outcome: z.enum(SKIPS),
	reason: z.string(),
});

export const toolReportSchema = z.discriminatedUnion("ran", [ranSchema, skippedSchema]);
export type ToolReport = z.infer<typeof toolReportSchema>;
export type RanReport = z.infer<typeof ranSchema>;

export const reportSchema = z.strictObject({
	reportVersion: z.literal(3),
	runId: z.string(),
	suite: z.string(),
	model: z.string(),
	platform: z.enum(["ios", "android"]),
	udid: z.string(),
	startedAt: z.string(),
	/** how many times each tool ran (`--reps`, default 1) */
	reps: repSchema,
	/** one row per tool and rep, in tool order then rep order */
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

/** The middle value (mean of the middle two for an even count); undefined for none. */
export function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid] ?? 0;
	return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? 0) + upper) / 2;
}

const tokensIn = (t: RanReport): number | undefined => {
	const k = t.metrics.result?.tokens;
	return k === undefined ? undefined : k.input + k.cacheRead + k.cacheWrite;
};

const num = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const count = (v: number): string => Math.round(v).toLocaleString("en-US");

/**
 * A numeric comparison row. `best` = lower is better, and the best tool that passed is bolded; `range` adds the
 * min–max over the reps behind the median.
 */
type Metric = {
	label: string;
	get: (t: RanReport) => number | undefined;
	format: (v: number) => string;
	best?: true;
	range?: true;
};

const METRIC_ROWS: Metric[] = [
	{ label: "agent wall", get: (t) => t.wallMs, format: secs, best: true, range: true },
	{ label: "prepare", get: (t) => t.prepareMs, format: secs },
	{ label: "turns", get: (t) => t.metrics.assistantTurns, format: num, best: true },
	{ label: "tool calls", get: (t) => t.metrics.toolCalls, format: num, best: true },
	{ label: "driver calls", get: (t) => t.metrics.driverCalls, format: num, best: true },
	{ label: "stumbles", get: (t) => t.metrics.stumbles, format: num, best: true },
	{ label: "cost", get: (t) => t.metrics.result?.costUsd, format: (v) => `$${v.toFixed(2)}`, best: true },
	{ label: "tokens in", get: tokensIn, format: count, best: true },
	{ label: "tokens out", get: (t) => t.metrics.result?.tokens.output, format: count, best: true },
];

/** One tool's rows across reps; `pool` = the reps its medians come from (passing ones, else every one that ran). */
type Group = { tool: ToolId; rows: ToolReport[]; ran: RanReport[]; passed: RanReport[]; pool: RanReport[] };

function groupOf(tool: ToolId, rows: ToolReport[]): Group {
	const ran = rows.filter((t): t is RanReport => t.ran);
	const passed = ran.filter((t) => t.outcome === "passed");
	return { tool, rows, ran, passed, pool: passed.length > 0 ? passed : ran };
}

/** Tool groups in `TOOL_IDS` order, each tool's rows in rep order. */
function groups(r: AgentReport): Group[] {
	return TOOL_IDS.flatMap((tool) => {
		const rows = r.tools.filter((t) => t.tool === tool).sort((a, b) => (a.rep ?? 0) - (b.rep ?? 0));
		return rows.length === 0 ? [] : [groupOf(tool, rows)];
	});
}

/** `✅ passed` for one rep; `✅ 3/3 passed` / `⚠️ 2/3 passed` / `❌ 0/3 passed` across reps; a tool that never ran keeps its skip. */
function outcomeCell(g: Group, reps: number): string {
	const first = g.rows[0];
	if (reps === 1 && first !== undefined) return `${MARK[first.outcome]} ${first.outcome}`;
	if (g.ran.length === 0 && first !== undefined && g.rows.every((t) => t.outcome === first.outcome))
		return `${MARK[first.outcome]} ${first.outcome}`;
	const mark = g.passed.length === g.rows.length ? "✅" : g.passed.length === 0 ? "❌" : "⚠️";
	return `${mark} ${g.passed.length}/${g.rows.length} passed`;
}

function checksCell(g: Group): string {
	if (g.ran.length === 0) return "—";
	const checks = g.ran.flatMap((t) => t.checks);
	return `${checks.filter((c) => c.passed).length}/${checks.length}`;
}

/** The median over the group's pool (undefined when no rep has the value). */
function medianOf(metric: Metric, g: Group): number | undefined {
	return median(g.pool.map(metric.get).filter((v) => v !== undefined));
}

function metricCell(metric: Metric, g: Group, best: number | undefined): string {
	const values = g.pool.map(metric.get).filter((v) => v !== undefined);
	const mid = median(values);
	if (g.ran.length === 0) return "—";
	if (mid === undefined) return "n/a";
	const spread =
		metric.range && values.length > 1
			? ` (${metric.format(Math.min(...values)).replace(/ s$/, "")}–${metric.format(Math.max(...values)).replace(/ s$/, "")})`
			: "";
	const cell = `${metric.format(mid)}${spread}`;
	return best !== undefined && g.passed.length > 0 && mid === best ? `**${cell}**` : cell;
}

/** The lowest median among tools with a passing rep; undefined unless at least two tools passed. */
function bestOf(metric: Metric, all: readonly Group[]): number | undefined {
	if (!metric.best) return undefined;
	const passing = all.filter((g) => g.passed.length > 0);
	const values = passing.map((g) => medianOf(metric, g)).filter((v) => v !== undefined);
	return passing.length > 1 && values.length > 0 ? Math.min(...values) : undefined;
}

/**
 * The side-by-side table that ends the report: one column per tool, best passing value in bold. With reps, each
 * cell is the median over the tool's passing reps (all its reps when none passed), wall time with its range.
 */
export function renderComparison(r: AgentReport): string[] {
	const all = groups(r);
	const row = (label: string, cells: string[]): string => `| ${label} | ${cells.join(" | ")} |`;
	return [
		`| | ${all.map((g) => g.tool).join(" | ")} |`,
		`|---|${all.map(() => "---").join("|")}|`,
		row(
			"outcome",
			all.map((g) => outcomeCell(g, r.reps))
		),
		row("checks", all.map(checksCell)),
		...METRIC_ROWS.map((m) => {
			const best = bestOf(m, all);
			return row(
				m.label,
				all.map((g) => metricCell(m, g, best))
			);
		}),
		row(
			"version",
			all.map((g) => (g.ran[0] === undefined ? "—" : `\`${g.ran[0].version}\``))
		),
	];
}

const toolName = (id: ToolId): string => `\`${id}\``;

const cost = (t: RanReport): string =>
	t.metrics.result === undefined ? "n/a" : `$${t.metrics.result.costUsd.toFixed(2)}`;

/** One row per rep: what the comparison's medians are made of. */
function repRow(t: ToolReport): string {
	const head = `| ${t.rep ?? "—"} | ${MARK[t.outcome]} ${t.outcome} |`;
	if (!t.ran) return `${head} ${t.reason} | | | | | | |`;
	const m = t.metrics;
	return `${head} ${secs(t.wallMs)} | ${secs(t.prepareMs)} | ${m.assistantTurns} | ${m.driverCalls} | ${m.stumbles} | ${cost(t)} | ${counts(m.errorCodes)} |`;
}

/** With reps: one section per tool (version, notes, checks that failed) and a row per rep. */
function repsSection(g: Group, reps: number): string[] {
	const failedChecks = [
		...new Set(g.ran.flatMap((t) => t.checks.filter((c) => !c.passed).map((c) => describeCheck(c.check)))),
	];
	const first = g.ran[0];
	return [
		`## ${g.tool} ${outcomeCell(g, reps)}`,
		"",
		...(first !== undefined ? [`- version \`${first.version}\``, ...first.notes.map((n) => `- note: ${n}`)] : []),
		...failedChecks.map((c) => `- ❌ \`${c}\` failed in some reps`),
		`- transcripts: \`${g.tool}/rep-<n>/\``,
		"",
		"| rep | outcome | agent wall | prepare | turns | driver calls | stumbles | cost | error codes |",
		"|---|---|---|---|---|---|---|---|---|",
		...g.rows.map(repRow),
		"",
	];
}

const FOOTNOTE =
	"Same model, prompt task, device and pinned app for every tool; each starts from a fresh install. Bold = best among tools that passed (lower is better). Driver calls = calls to the tool under test (its CLI via Bash, or its MCP tools). Checks run through `warden ui` after the tool's own helpers are stopped.";
const REPS_FOOTNOTE =
	"Medians over passing reps (over every rep when a tool never passed); agent wall shows min–max. Tools run interleaved, rep by rep, so drift in host load is spread across them.";

/** The human summary written next to `report.json`; the comparison table comes last. */
export function renderMarkdown(r: AgentReport): string {
	const all = groups(r);
	const reps = r.reps > 1 ? ` · ${r.reps} reps` : "";
	return [
		`# agent bench: ${r.suite} — ${allPassed(r) ? "all passed" : "not all passed"}`,
		"",
		`Run \`${r.runId}\` · model \`${r.model}\` · ${r.platform} \`${r.udid}\` · started ${r.startedAt} · tools ${all.map((g) => toolName(g.tool)).join(", ")}${reps}`,
		"",
		...(r.reps > 1 ? all.flatMap((g) => repsSection(g, r.reps)) : r.tools.flatMap(toolSection)),
		"## Comparison",
		"",
		...renderComparison(r),
		"",
		r.reps > 1 ? `${FOOTNOTE} ${REPS_FOOTNOTE}` : FOOTNOTE,
		"",
	].join("\n");
}
