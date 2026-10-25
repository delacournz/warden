import type { FramesReport } from "../frames/analyze";
import { type Hotspots, hotspotFindings, hotspotsSection } from "../js/hotspots";
import { memoryGrowthFinding, type SeriesSummary } from "../metrics/series";
import { type ReactAnalysis, reactSection } from "../react/analyze";
import type { StartupStats } from "../startup/stats";
import { type Finding, SEVERITY_ORDER } from "./findings.types";
import { DEV_BUILD_BANNER, type Report, type ReportSection, renderMarkdown, SIMULATOR_BANNER } from "./render-md";
import type { Mark, PerfSession } from "./session.schema";

/** The sections of a session report, in print order. `Next` is the report's `next:` block. */
export const SECTION_IDS = ["startup", "frames", "js-cpu", "react", "native-cpu", "hangs", "memory", "logs"] as const;
export type SectionId = (typeof SECTION_IDS)[number];

export type ReportSectionJson = ReportSection & { id: SectionId };

export type StartupInput = {
	method: string;
	summary: { cold?: StartupStats; warm?: StartupStats };
	findings: Finding[];
	notes: string[];
};

export type FramesInput = Pick<
	FramesReport,
	| "fps"
	| "refreshHz"
	| "jankPct"
	| "jankyFrames"
	| "totalFrames"
	| "droppedFrames"
	| "frozenFrames"
	| "worstFrameMs"
	| "deadlineMs"
	| "worstWindows"
> & { findings: Finding[] };

/** A React commit reduced to what the merger needs to line it up with other events. */
export type CommitBrief = { index: number; wallMs: number; durationMs: number; top: string[] };

export type NativeHangBrief = { atMs: number; durationMs: number; kind: string };

export type NativeInput = {
	platform: "ios" | "android";
	/** host clock when the recording started: `atMs` of every hang counts from here */
	traceStartWallMs?: number;
	hangs: NativeHangBrief[];
	topFunctions: Array<{ name: string; selfPct: number }>;
	findings: Finding[];
	summary: string[];
	section: ReportSection;
};

export type LogsInput = { lines: number; errorCount: number; errors: string[] };

export type CrashesInput = { count: number; lines: string[]; findings: Finding[] };

export type ReportInput = {
	session: PerfSession;
	/** the clock a still-running session's length is measured against */
	now: number;
	startup?: StartupInput;
	frames?: FramesInput;
	metrics?: SeriesSummary;
	js?: Hotspots;
	react?: { analysis: ReactAnalysis; commits: CommitBrief[] };
	native?: NativeInput;
	logs?: LogsInput;
	crashes?: CrashesInput;
};

/** One event on the timeline that overlaps another capturer's: the report's "this hang is that commit" lines. */
export type Correlation =
	| {
			kind: "hang-commit";
			atMs: number;
			durationMs: number;
			commit: { index: number; durationMs: number; top: string[] };
			mark?: string;
			text: string;
	  }
	| {
			kind: "jank-commit";
			atMs: number;
			durationMs: number;
			commit: { index: number; durationMs: number; top: string[] };
			mark?: string;
			text: string;
	  };

/** The numbers `perf diff` compares; each is lower-is-better. */
export type ReportMetrics = {
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

/** `report.json`. */
export type PerfReportJson = {
	version: 1;
	sessionId: string;
	device: PerfSession["device"];
	app?: string;
	startedAt: number;
	durationMs: number;
	stopReason?: string;
	banners: string[];
	summary: string[];
	findings: Finding[];
	sections: ReportSectionJson[];
	correlations: Correlation[];
	marks: Mark[];
	metrics: ReportMetrics;
	next: string[];
};

const sec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
const round = (n: number, digits = 1): number => Math.round(n * 10 ** digits) / 10 ** digits;
const mb = (kb: number): string => `${(kb / 1024).toFixed(1)} MB`;

/** Device wall clock minus host wall clock at the session start (0 on a simulator: it shares the host clock). */
export function clockOffsetMs(session: PerfSession): number {
	const { deviceWallMs, wallMs } = session.startedAt;
	return deviceWallMs === undefined ? 0 : deviceWallMs - wallMs;
}

/** A device wall time as ms on the session timeline. */
export function deviceWallToSessionMs(session: PerfSession, deviceWallMs: number): number {
	return deviceWallMs - clockOffsetMs(session) - session.startedAt.wallMs;
}

/** A host wall time as ms on the session timeline. */
export const hostWallToSessionMs = (session: PerfSession, hostWallMs: number): number =>
	hostWallMs - session.startedAt.wallMs;

/** The last mark at or before `atMs`. */
export function markBefore(marks: readonly Mark[], atMs: number): string | undefined {
	let found: Mark | undefined;
	for (const m of marks) if (m.atMs <= atMs && (found === undefined || m.atMs >= found.atMs)) found = m;
	return found?.label;
}

type Span = { startMs: number; endMs: number };

const overlap = (a: Span, b: Span): number => Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));

function commitSpan(session: PerfSession, c: CommitBrief): Span {
	const startMs = deviceWallToSessionMs(session, c.wallMs);
	return { startMs, endMs: startMs + c.durationMs };
}

/** The commit that overlaps `span` the most (ties: the slower one). */
function bestCommit(session: PerfSession, commits: readonly CommitBrief[], span: Span): CommitBrief | undefined {
	let best: { commit: CommitBrief; overlapMs: number } | undefined;
	for (const commit of commits) {
		const overlapMs = overlap(span, commitSpan(session, commit));
		if (overlapMs <= 0) continue;
		if (
			best === undefined ||
			overlapMs > best.overlapMs ||
			(overlapMs === best.overlapMs && commit.durationMs > best.commit.durationMs)
		)
			best = { commit, overlapMs };
	}
	return best?.commit;
}

const commitLabel = (c: { index: number; durationMs: number; top: string[] }): string =>
	`commit #${c.index} (${c.top.length > 0 ? `${c.top.slice(0, 2).join(", ")}, ` : ""}${Math.round(c.durationMs)}ms)`;

type TimelineEvent = { kind: "hang" | "jank"; atMs: number; durationMs: number };

/** Hangs and jank windows on the session timeline. */
function timelineEvents(input: ReportInput): TimelineEvent[] {
	const { session, native, frames } = input;
	const events: TimelineEvent[] = [];
	if (native !== undefined) {
		const base = native.traceStartWallMs === undefined ? 0 : hostWallToSessionMs(session, native.traceStartWallMs);
		for (const h of native.hangs) events.push({ kind: "hang", atMs: base + h.atMs, durationMs: h.durationMs });
	}
	for (const w of frames?.worstWindows ?? []) {
		events.push({
			kind: "jank",
			atMs: w.startOffsetMs,
			durationMs: Math.max(w.worstFrameMs, w.endOffsetMs - w.startOffsetMs),
		});
	}
	return events.sort((a, b) => a.atMs - b.atMs);
}

/** Line each hang and jank window up with the React commit it overlaps and the mark it follows. */
export function correlate(input: ReportInput): Correlation[] {
	const commits = input.react?.commits ?? [];
	if (commits.length === 0) return [];
	const out: Correlation[] = [];
	for (const e of timelineEvents(input)) {
		const commit = bestCommit(input.session, commits, { startMs: e.atMs, endMs: e.atMs + e.durationMs });
		if (commit === undefined) continue;
		const mark = markBefore(input.session.marks, e.atMs);
		const brief = { index: commit.index, durationMs: commit.durationMs, top: commit.top };
		const what = e.kind === "hang" ? "hang" : "jank";
		const text = `${what} ${Math.round(e.durationMs)}ms @ ${sec(e.atMs)} overlaps ${commitLabel(brief)}${
			mark === undefined ? "" : ` ← mark '${mark}'`
		}`;
		out.push({
			kind: e.kind === "hang" ? "hang-commit" : "jank-commit",
			atMs: e.atMs,
			durationMs: e.durationMs,
			commit: brief,
			...(mark === undefined ? {} : { mark }),
			text,
		});
	}
	return out;
}

function startupSection(s: StartupInput): ReportSectionJson {
	const lines: string[] = [];
	for (const kind of ["cold", "warm"] as const) {
		const stats = s.summary[kind];
		if (stats === undefined) continue;
		lines.push(
			`${kind}: median ${stats.medianMs}ms, p90 ${stats.p90Ms}ms, ${stats.minMs}-${stats.maxMs}ms over ${stats.runs} run${stats.runs === 1 ? "" : "s"} (${s.method})`
		);
	}
	lines.push(...s.notes.map((n) => `note: ${n}`));
	return { id: "startup", title: "Startup", lines };
}

function framesSection(f: FramesInput, marks: readonly Mark[]): ReportSectionJson {
	const lines = [
		`${f.fps} fps @ ${f.refreshHz}Hz, ${f.jankPct}% janky (${f.jankyFrames}/${f.totalFrames}), ${f.droppedFrames} dropped, ${f.frozenFrames} frozen, worst ${f.worstFrameMs}ms`,
	];
	for (const w of f.worstWindows) {
		const mark = w.mark ?? markBefore(marks, w.startOffsetMs);
		lines.push(
			`- ${sec(w.startOffsetMs)}..${sec(w.endOffsetMs)}: ${w.missedDeadlineFrameCount} frames over ${f.deadlineMs}ms, worst ${w.worstFrameMs}ms${mark === undefined ? "" : ` ← mark '${mark}'`}`
		);
	}
	return { id: "frames", title: "Frames", lines };
}

function hangsSection(input: ReportInput, correlations: readonly Correlation[]): ReportSectionJson | undefined {
	const native = input.native;
	if (native === undefined || native.hangs.length === 0) return undefined;
	const base = native.traceStartWallMs === undefined ? 0 : hostWallToSessionMs(input.session, native.traceStartWallMs);
	const lines = [...native.hangs]
		.sort((a, b) => b.durationMs - a.durationMs)
		.slice(0, 8)
		.map((h) => {
			const at = base + h.atMs;
			const mark = markBefore(input.session.marks, at);
			return `- ${Math.round(h.durationMs)}ms @ ${sec(at)}${h.kind === "" ? "" : ` (${h.kind})`}${mark === undefined ? "" : ` ← mark '${mark}'`}`;
		});
	if (native.hangs.length > 8) lines.push(`  ... ${native.hangs.length - 8} more (warden perf query <id> stacks hang)`);
	const hangLines = correlations.filter((c) => c.kind === "hang-commit").map((c) => `overlap: ${c.text}`);
	return { id: "hangs", title: "Hangs", lines: [...lines, ...hangLines] };
}

function memorySection(m: SeriesSummary): ReportSectionJson {
	const lines = [`${m.count} samples over ${sec(m.durationMs)}`];
	if (m.cpuPct !== undefined)
		lines.push(
			`cpu: avg ${m.cpuPct.avg.toFixed(1)}%, p95 ${m.cpuPct.p95.toFixed(1)}%, max ${m.cpuPct.max.toFixed(1)}%`
		);
	lines.push(`rss: min ${mb(m.rssKb.min)}, avg ${mb(m.rssKb.avg)}, max ${mb(m.rssKb.max)}`);
	if (m.pssKb !== undefined) lines.push(`pss: min ${mb(m.pssKb.min)}, avg ${mb(m.pssKb.avg)}, max ${mb(m.pssKb.max)}`);
	if (m.fps !== undefined) lines.push(`fps: avg ${m.fps.avg.toFixed(1)}, min ${m.fps.min.toFixed(1)}`);
	if (m.growth !== undefined) {
		const g = m.growth;
		lines.push(
			`${g.metric} ${mb(g.startKb)} to ${mb(g.endKb)} (${g.slopeKbPerSec >= 0 ? "+" : ""}${Math.round(g.slopeKbPerSec)} KB/s)`
		);
	}
	return { id: "memory", title: "Memory", lines };
}

function logsSection(logs: LogsInput | undefined, crashes: CrashesInput | undefined): ReportSectionJson | undefined {
	if (logs === undefined && crashes === undefined) return undefined;
	const lines: string[] = [];
	if (logs !== undefined) {
		lines.push(`${logs.lines} log lines, ${logs.errorCount} errors`);
		lines.push(...logs.errors.map((e) => `  ${e}`));
	}
	if (crashes !== undefined) {
		lines.push(crashes.count === 0 ? "no crashes" : `${crashes.count} crash${crashes.count === 1 ? "" : "es"}`);
		lines.push(...crashes.lines.map((l) => `  ${l}`));
	}
	return { id: "logs", title: "Logs / Crashes", lines };
}

function rank(findings: readonly Finding[]): Finding[] {
	return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || b.costMs - a.costMs);
}

function growthFindings(input: ReportInput): Finding[] {
	const finding = input.metrics === undefined ? undefined : memoryGrowthFinding(input.metrics);
	return finding === undefined ? [] : [finding];
}

function metricsOf(input: ReportInput): ReportMetrics {
	const { startup, frames, metrics, react, native, js } = input;
	const topFunctions =
		native !== undefined && native.topFunctions.length > 0
			? native.topFunctions
			: (js?.topSelf ?? []).map((f) => ({ name: f.name, selfPct: f.selfPct }));
	const peakCommit = (react?.commits ?? []).reduce((m, c) => Math.max(m, c.durationMs), 0);
	const hangs = native?.hangs ?? [];
	return {
		...(startup?.summary.cold === undefined ? {} : { startupColdMs: startup.summary.cold.medianMs }),
		...(startup?.summary.warm === undefined ? {} : { startupWarmMs: startup.summary.warm.medianMs }),
		...(frames === undefined ? {} : { jankPct: frames.jankPct, fps: frames.fps }),
		...(metrics?.cpuPct === undefined ? {} : { cpuP95Pct: round(metrics.cpuPct.p95) }),
		...(metrics?.pssKb === undefined ? {} : { peakPssKb: Math.round(metrics.pssKb.max) }),
		...(metrics === undefined ? {} : { peakRssKb: Math.round(metrics.rssKb.max) }),
		...(react === undefined || peakCommit === 0 ? {} : { topCommitMs: round(peakCommit) }),
		...(native === undefined
			? {}
			: { hangCount: hangs.length, hangTotalMs: Math.round(hangs.reduce((s, h) => s + h.durationMs, 0)) }),
		topFunctions: topFunctions.slice(0, 10).map((f) => ({ name: f.name, selfPct: round(f.selfPct) })),
	};
}

function nextHints(id: string, input: ReportInput, findings: readonly Finding[]): string[] {
	const next: string[] = [];
	if (input.react !== undefined && input.react.analysis.components.length > 0)
		next.push(`warden perf query ${id} commits --by component`);
	if ((input.native?.hangs.length ?? 0) > 0) next.push(`warden perf query ${id} stacks hang`);
	if (input.js !== undefined) next.push(`warden perf query ${id} cpu --top`);
	if (input.frames !== undefined && input.frames.worstWindows.length > 0)
		next.push(`warden perf query ${id} frames --worst`);
	if (input.metrics?.growth !== undefined && findings.some((f) => f.kind === "memory-growth"))
		next.push("warden perf memory --snapshot");
	next.push(`warden perf record --relaunch --all   (then: warden perf diff ${id} <new id>)`);
	return next;
}

function summaryOf(input: ReportInput, durationMs: number, findings: readonly Finding[]): string[] {
	const { session } = input;
	const lines = [
		`${session.app?.id ?? "app"} on ${session.device.name ?? session.device.udid} (${session.device.platform}): ${sec(durationMs)}${
			session.stopReason === undefined ? "" : `, stopped (${session.stopReason})`
		}`,
	];
	const ran = session.capturers.filter((c) => c.kind !== "collector" && c.state !== "failed").map((c) => c.kind);
	const failed = session.capturers.filter((c) => c.kind !== "collector" && c.state === "failed").map((c) => c.kind);
	if (ran.length > 0 || failed.length > 0)
		lines.push(`captured: ${ran.join(", ") || "nothing"}${failed.length > 0 ? `; failed: ${failed.join(", ")}` : ""}`);
	const count = (sev: Finding["severity"]) => findings.filter((f) => f.severity === sev).length;
	lines.push(
		findings.length === 0
			? "findings: none"
			: `findings: ${count("critical")} critical, ${count("warn")} warn, ${count("info")} info`
	);
	if (session.marks.length > 0)
		lines.push(
			`marks: ${session.marks
				.slice(0, 5)
				.map((m) => `'${m.label}' @ ${sec(m.atMs)}`)
				.join(", ")}`
		);
	return lines;
}

/** Merge every capturer's output onto the session timeline: summary, ranked findings, sections, correlations, diff metrics, next hints. Pure. */
export function buildReport(input: ReportInput): PerfReportJson {
	const { session } = input;
	const durationMs = Math.max(0, (session.stoppedAt ?? input.now) - session.startedAt.wallMs);
	const correlations = correlate(input);
	const findings = rank([
		...(input.startup?.findings ?? []),
		...(input.frames?.findings ?? []),
		...(input.js === undefined ? [] : hotspotFindings(input.js)),
		...(input.react?.analysis.findings ?? []),
		...(input.native?.findings ?? []),
		...growthFindings(input),
		...(input.crashes?.findings ?? []),
	]);
	const sections: ReportSectionJson[] = [];
	if (input.startup !== undefined) sections.push(startupSection(input.startup));
	if (input.frames !== undefined) sections.push(framesSection(input.frames, session.marks));
	if (input.js !== undefined) sections.push({ id: "js-cpu", ...hotspotsSection(input.js) });
	if (input.react !== undefined) {
		const section = reactSection(input.react.analysis);
		const joined = correlations.filter((c) => c.kind === "jank-commit").map((c) => `overlap: ${c.text}`);
		sections.push({
			id: "react",
			...section,
			lines: [...section.lines, ...(joined.length > 0 ? ["", ...joined] : [])],
		});
	}
	if (input.native !== undefined) sections.push({ id: "native-cpu", ...input.native.section });
	const hangs = hangsSection(input, correlations);
	if (hangs !== undefined) sections.push(hangs);
	if (input.metrics !== undefined) sections.push(memorySection(input.metrics));
	const logs = logsSection(input.logs, input.crashes);
	if (logs !== undefined) sections.push(logs);
	const dev = input.js?.dev === true || input.react?.analysis.dev === true;
	return {
		version: 1,
		sessionId: session.id,
		device: session.device,
		...(session.app === undefined ? {} : { app: session.app.id }),
		startedAt: session.startedAt.wallMs,
		durationMs,
		...(session.stopReason === undefined ? {} : { stopReason: session.stopReason }),
		banners: [SIMULATOR_BANNER, ...(dev ? [DEV_BUILD_BANNER] : [])],
		summary: summaryOf(input, durationMs, findings),
		findings,
		sections,
		correlations,
		marks: session.marks,
		metrics: metricsOf(input),
		next: nextHints(session.id, input, findings),
	};
}

/** `report.json` as the capped (or full) markdown a text run prints. */
export function renderReportMarkdown(report: PerfReportJson, options: { maxLines?: number } = {}): string {
	const view: Report = {
		title: `perf session ${report.sessionId}`,
		banners: report.banners,
		summary: report.summary,
		findings: report.findings,
		sections: report.sections.map(({ title, lines }) => ({ title, lines })),
		next: report.next,
	};
	return renderMarkdown(view, options);
}

const isErrorLine = (line: string): boolean => /\s[EF]\s/.test(line) || /\b(?:error|fatal|exception)\b/i.test(line);

/** Line count, error count and the first few error lines of a session's `logs/device.log`. */
export function summarizeLogs(text: string, maxErrors = 5): LogsInput {
	const lines = text.split("\n").filter((l) => l.trim() !== "");
	const errors = lines.filter(isErrorLine);
	return {
		lines: lines.length,
		errorCount: errors.length,
		errors: errors.slice(0, maxErrors).map((l) => l.slice(0, 200)),
	};
}
