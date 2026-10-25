import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hotspots } from "@delacour/warden-perf/js/hotspots";
import { decodeSamples, summarize } from "@delacour/warden-perf/metrics/series";
import type { ReactAnalysis } from "@delacour/warden-perf/react/analyze";
import { type CommitsFile, commitsFileSchema } from "@delacour/warden-perf/react/react.types";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import type { ReportSection } from "@delacour/warden-perf/shared/render-md";
import {
	buildReport,
	type CommitBrief,
	type CrashesInput,
	type FramesInput,
	type NativeHangBrief,
	type NativeInput,
	type PerfReportJson,
	type ReportInput,
	renderReportMarkdown,
	type StartupInput,
	summarizeLogs,
} from "@delacour/warden-perf/shared/report";
import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { writeFileAtomic } from "../agent-ui/state";
import type { CommandContext } from "../context";
import type { NativeAnalysis } from "./native-types";
import { sessionDir } from "./paths";
import { readSession } from "./session";

export const REPORT_JSON = "report.json";
export const REPORT_MD = "report.md";
export const NATIVE_SUMMARY = join("native", "summary.json");
export const CRASH_SUMMARY = join("crashes", "summary.json");

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** `native/summary.json`: what the merger needs of a native analysis, written when the recorder stops. */
export type NativeSummaryFile = NativeInput & { version: 1; files: Record<string, string> };

/** Pull the hangs and top functions out of a platform's analysis JSON (iOS `NativeReport`, Android perfetto or simpleperf). */
export function nativeBrief(
	platform: "ios" | "android",
	report: unknown,
	handleStartWallMs?: number
): { traceStartWallMs?: number; hangs: NativeHangBrief[]; topFunctions: Array<{ name: string; selfPct: number }> } {
	const hangs: NativeHangBrief[] = [];
	const topFunctions: Array<{ name: string; selfPct: number }> = [];
	let traceStartWallMs = handleStartWallMs;
	if (isRecord(report)) {
		if (platform === "ios") {
			traceStartWallMs = num(report.traceStartWallMs) ?? traceStartWallMs;
			for (const h of arr(report.hangs)) {
				if (!isRecord(h)) continue;
				const atMs = num(h.atMs);
				const durationMs = num(h.durationMs);
				if (atMs !== undefined && durationMs !== undefined)
					hangs.push({ atMs, durationMs, kind: str(h.kind) ?? "hang" });
			}
			for (const h of arr(report.hotspots)) {
				if (isRecord(h) && str(h.frame) !== undefined && num(h.selfPct) !== undefined)
					topFunctions.push({ name: str(h.frame) ?? "", selfPct: num(h.selfPct) ?? 0 });
			}
		} else if (report.mode === "simpleperf") {
			for (const r of arr(report.top)) {
				if (isRecord(r) && str(r.symbol) !== undefined && num(r.percent) !== undefined)
					topFunctions.push({ name: str(r.symbol) ?? "", selfPct: num(r.percent) ?? 0 });
			}
		} else {
			const hangRoot = report.hangs;
			for (const h of isRecord(hangRoot) ? arr(hangRoot.hangs) : []) {
				if (!isRecord(h)) continue;
				const atMs = num(h.atMs);
				const durationMs = num(h.durMs);
				if (atMs !== undefined && durationMs !== undefined)
					hangs.push({ atMs, durationMs, kind: str(h.jankType) ?? "hang" });
			}
			const cpu = report.cpu;
			for (const f of isRecord(cpu) ? arr(cpu.functions) : []) {
				if (isRecord(f) && str(f.function) !== undefined && num(f.selfPct) !== undefined)
					topFunctions.push({ name: str(f.function) ?? "", selfPct: num(f.selfPct) ?? 0 });
			}
		}
	}
	return {
		...(traceStartWallMs === undefined ? {} : { traceStartWallMs }),
		hangs,
		topFunctions: topFunctions.slice(0, 10),
	};
}

export function nativeSummaryOf(
	platform: "ios" | "android",
	analysis: NativeAnalysis,
	handleStartWallMs?: number
): NativeSummaryFile {
	return {
		version: 1,
		platform,
		...nativeBrief(platform, analysis.report, handleStartWallMs),
		findings: analysis.findings,
		summary: analysis.summary,
		section: analysis.section,
		files: analysis.files,
	};
}

export function writeNativeSummary(ctx: Pick<CommandContext, "env">, id: string, file: NativeSummaryFile): void {
	mkdirSync(join(sessionDir(ctx, id), "native"), { recursive: true });
	writeFileAtomic(join(sessionDir(ctx, id), NATIVE_SUMMARY), `${JSON.stringify(file, null, 2)}\n`);
}

function readNative(dir: string): NativeInput | undefined {
	const raw = readJson(join(dir, NATIVE_SUMMARY));
	if (!isRecord(raw) || raw.version !== 1) return undefined;
	const platform = raw.platform === "ios" || raw.platform === "android" ? raw.platform : undefined;
	const section = isRecord(raw.section) ? raw.section : undefined;
	if (platform === undefined || section === undefined) return undefined;
	const hangs: NativeHangBrief[] = arr(raw.hangs).flatMap((h) =>
		isRecord(h) && num(h.atMs) !== undefined && num(h.durationMs) !== undefined
			? [{ atMs: num(h.atMs) ?? 0, durationMs: num(h.durationMs) ?? 0, kind: str(h.kind) ?? "hang" }]
			: []
	);
	const topFunctions = arr(raw.topFunctions).flatMap((f) =>
		isRecord(f) && str(f.name) !== undefined && num(f.selfPct) !== undefined
			? [{ name: str(f.name) ?? "", selfPct: num(f.selfPct) ?? 0 }]
			: []
	);
	const sectionLines: ReportSection = {
		title: str(section.title) ?? "Native CPU",
		lines: arr(section.lines).filter((l): l is string => typeof l === "string"),
	};
	return {
		platform,
		...(num(raw.traceStartWallMs) === undefined ? {} : { traceStartWallMs: num(raw.traceStartWallMs) ?? 0 }),
		hangs,
		topFunctions,
		findings: arr(raw.findings).filter(isRecord) as unknown as Finding[],
		summary: arr(raw.summary).filter((l): l is string => typeof l === "string"),
		section: sectionLines,
	};
}

function readStartup(dir: string): StartupInput | undefined {
	const raw = readJson(join(dir, "metrics", "startup.json"));
	if (!isRecord(raw) || str(raw.method) === undefined || !isRecord(raw.summary)) return undefined;
	const pick = (k: "cold" | "warm") => {
		const s = raw.summary;
		const v = isRecord(s) ? s[k] : undefined;
		return isRecord(v) && num(v.medianMs) !== undefined
			? {
					runs: num(v.runs) ?? 1,
					medianMs: num(v.medianMs) ?? 0,
					p90Ms: num(v.p90Ms) ?? 0,
					minMs: num(v.minMs) ?? 0,
					maxMs: num(v.maxMs) ?? 0,
				}
			: undefined;
	};
	const cold = pick("cold");
	const warm = pick("warm");
	return {
		method: str(raw.method) ?? "",
		summary: { ...(cold === undefined ? {} : { cold }), ...(warm === undefined ? {} : { warm }) },
		findings: arr(raw.findings).filter(isRecord) as unknown as Finding[],
		notes: arr(raw.notes).filter((n): n is string => typeof n === "string"),
	};
}

function readFrames(dir: string): FramesInput | undefined {
	const raw = readJson(join(dir, "frames.json"));
	if (!isRecord(raw) || raw.status !== "ok") return undefined;
	return raw as unknown as FramesInput;
}

function readHotspots(dir: string): Hotspots | undefined {
	const raw = readJson(join(dir, "js", "hotspots.json"));
	return isRecord(raw) && raw.version === 1 && Array.isArray(raw.topSelf) ? (raw as unknown as Hotspots) : undefined;
}

/** `react/commits.json` parsed, for queries and the merger. */
export function readCommitsFile(dir: string): CommitsFile | undefined {
	const parsed = commitsFileSchema.safeParse(readJson(join(dir, "react", "commits.json")));
	return parsed.success ? parsed.data : undefined;
}

function readReact(dir: string): ReportInput["react"] {
	const raw = readJson(join(dir, "react", "findings.json"));
	const file = readCommitsFile(dir);
	if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.findings)) return undefined;
	const commits: CommitBrief[] = (file?.commits ?? []).map((c) => ({
		index: c.index,
		wallMs: c.wallMs,
		durationMs: c.durationMs,
		top: [...c.fibers]
			.sort((a, b) => b.selfMs - a.selfMs)
			.slice(0, 2)
			.map((f) => f.name),
	}));
	return { analysis: raw as unknown as ReactAnalysis, commits };
}

function readCrashes(dir: string): CrashesInput | undefined {
	const raw = readJson(join(dir, CRASH_SUMMARY));
	if (!isRecord(raw)) return undefined;
	return {
		count: num(raw.count) ?? 0,
		lines: arr(raw.lines).filter((l): l is string => typeof l === "string"),
		findings: arr(raw.findings).filter(isRecord) as unknown as Finding[],
	};
}

/** Everything the merger needs, read from the session directory. Capturers that left nothing are simply absent. */
export function loadReportInput(ctx: Pick<CommandContext, "env" | "now">, session: PerfSession): ReportInput {
	const dir = sessionDir(ctx, session.id);
	const samples = decodeSamples(readText(join(dir, "metrics", "samples.jsonl")) ?? "");
	const metrics = summarize(samples);
	const logText = readText(join(dir, "logs", "device.log"));
	const startup = readStartup(dir);
	const frames = readFrames(dir);
	const js = readHotspots(dir);
	const react = readReact(dir);
	const native = readNative(dir);
	const crashes = readCrashes(dir);
	return {
		session,
		now: ctx.now(),
		...(startup === undefined ? {} : { startup }),
		...(frames === undefined ? {} : { frames }),
		...(metrics === undefined ? {} : { metrics }),
		...(js === undefined ? {} : { js }),
		...(react === undefined ? {} : { react }),
		...(native === undefined ? {} : { native }),
		...(logText === undefined ? {} : { logs: summarizeLogs(logText) }),
		...(crashes === undefined ? {} : { crashes }),
	};
}

/** Merge the session's files into `report.json` + `report.md` (full markdown) in its directory. */
export function writeSessionReport(ctx: Pick<CommandContext, "env" | "now">, session: PerfSession): PerfReportJson {
	const report = buildReport(loadReportInput(ctx, session));
	const dir = sessionDir(ctx, session.id);
	writeFileAtomic(join(dir, REPORT_JSON), `${JSON.stringify(report, null, 2)}\n`);
	writeFileAtomic(join(dir, REPORT_MD), `${renderReportMarkdown(report)}\n`);
	return report;
}

/** A session's `report.json`, as written (undefined when the session has none yet or it does not parse). */
export function readSessionReport(ctx: Pick<CommandContext, "env">, id: string): PerfReportJson | undefined {
	const raw = readJson(join(sessionDir(ctx, id), REPORT_JSON));
	return isRecord(raw) && raw.version === 1 && str(raw.sessionId) !== undefined && isRecord(raw.metrics)
		? (raw as unknown as PerfReportJson)
		: undefined;
}

/** The report for `id`: the written one, else built (and written) from its files. */
export function reportFor(ctx: Pick<CommandContext, "env" | "now">, id: string): PerfReportJson | undefined {
	const written = readSessionReport(ctx, id);
	if (written !== undefined) return written;
	const session = readSession(ctx, id);
	return session === undefined ? undefined : writeSessionReport(ctx, session);
}
