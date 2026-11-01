import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hotspots } from "@delacour/warden-perf/js/hotspots";
import { sampleSeries } from "@delacour/warden-perf/metrics/series";
import type { ReactAnalysis } from "@delacour/warden-perf/react/analyze";
import { type CommitsFile, commitsFileSchema } from "@delacour/warden-perf/react/react.types";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import type { ReportSection } from "@delacour/warden-perf/shared/render-md";
import {
	type CommitBrief,
	type CrashesInput,
	type FramesInput,
	type NativeHangBrief,
	type NativeInput,
	type PerfReportJson,
	type ReportInput,
	reportBuilder,
	type StartupInput,
} from "@delacour/warden-perf/shared/report";
import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { perfDeviceState } from "./device-state";
import type { PerfEnv } from "./env";
import type { NativeAnalysis } from "./native-types";
import { perfPaths } from "./paths";
import { perfSessionStore } from "./session";

export const REPORT_JSON = "report.json";
export const REPORT_MD = "report.md";
export const NATIVE_SUMMARY = join("native", "summary.json");
export const CRASH_SUMMARY = join("crashes", "summary.json");

/** `native/summary.json`: what the merger needs of a native analysis, written when the recorder stops. */
export type NativeSummaryFile = NativeInput & { version: 1; files: Record<string, string> };

type TopFunction = { name: string; selfPct: number };
type RawBrief = { traceStartWallMs: number | undefined; hangs: NativeHangBrief[]; topFunctions: TopFunction[] };

/** ReportReader: report read. */
export class ReportReader {
	private readonly isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

	private readJson(path: string): unknown {
		try {
			return JSON.parse(readFileSync(path, "utf8"));
		} catch {
			return undefined;
		}
	}

	private readText(path: string): string | undefined {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	}

	private readonly num = (v: unknown): number | undefined =>
		typeof v === "number" && Number.isFinite(v) ? v : undefined;

	private readonly str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

	private readonly arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

	/** Map each record in `items` through `row`, skipping non-records. */
	private recordRows<T>(items: unknown[], row: (r: Record<string, unknown>) => T[]): T[] {
		return items.flatMap((i) => (this.isRecord(i) ? row(i) : []));
	}

	/** A hang from `h.atMs` + `h[durKey]`; none when either is missing. */
	private hangRow(h: Record<string, unknown>, durKey: string, kindKey: string): NativeHangBrief[] {
		const atMs = this.num(h.atMs);
		const durationMs = this.num(h[durKey]);
		return atMs !== undefined && durationMs !== undefined
			? [{ atMs, durationMs, kind: this.str(h[kindKey]) ?? "hang" }]
			: [];
	}

	/** A top function from `h[nameKey]` + `h[pctKey]`; none when either is missing. */
	private topRow(h: Record<string, unknown>, nameKey: string, pctKey: string): TopFunction[] {
		const name = this.str(h[nameKey]);
		const selfPct = this.num(h[pctKey]);
		return name !== undefined && selfPct !== undefined ? [{ name, selfPct }] : [];
	}

	/** iOS `NativeReport`: hangs plus hotspot frames. */
	private iosBrief(report: Record<string, unknown>, handleStartWallMs: number | undefined): RawBrief {
		return {
			traceStartWallMs: this.num(report.traceStartWallMs) ?? handleStartWallMs,
			hangs: this.recordRows(this.arr(report.hangs), (h) => this.hangRow(h, "durationMs", "kind")),
			topFunctions: this.recordRows(this.arr(report.hotspots), (h) => this.topRow(h, "frame", "selfPct")),
		};
	}

	/** Android simpleperf: only top symbols, no hangs. */
	private simpleperfBrief(report: Record<string, unknown>, handleStartWallMs: number | undefined): RawBrief {
		return {
			traceStartWallMs: handleStartWallMs,
			hangs: [],
			topFunctions: this.recordRows(this.arr(report.top), (r) => this.topRow(r, "symbol", "percent")),
		};
	}

	/** Android perfetto: jank hangs plus CPU functions. */
	private perfettoBrief(report: Record<string, unknown>, handleStartWallMs: number | undefined): RawBrief {
		const hangRoot = report.hangs;
		const cpu = report.cpu;
		return {
			traceStartWallMs: handleStartWallMs,
			hangs: this.recordRows(this.isRecord(hangRoot) ? this.arr(hangRoot.hangs) : [], (h) =>
				this.hangRow(h, "durMs", "jankType")
			),
			topFunctions: this.recordRows(this.isRecord(cpu) ? this.arr(cpu.functions) : [], (f) =>
				this.topRow(f, "function", "selfPct")
			),
		};
	}

	/** Pick the brief reader for a platform's analysis shape. */
	private briefOf(
		platform: "ios" | "android",
		report: Record<string, unknown>,
		handleStartWallMs: number | undefined
	): RawBrief {
		if (platform === "ios") return this.iosBrief(report, handleStartWallMs);
		if (report.mode === "simpleperf") return this.simpleperfBrief(report, handleStartWallMs);
		return this.perfettoBrief(report, handleStartWallMs);
	}

	/** Pull the hangs and top functions out of a platform's analysis JSON (iOS `NativeReport`, Android perfetto or simpleperf). */
	nativeBrief(
		platform: "ios" | "android",
		report: unknown,
		handleStartWallMs?: number
	): { traceStartWallMs?: number; hangs: NativeHangBrief[]; topFunctions: Array<{ name: string; selfPct: number }> } {
		const brief: RawBrief = this.isRecord(report)
			? this.briefOf(platform, report, handleStartWallMs)
			: { traceStartWallMs: handleStartWallMs, hangs: [], topFunctions: [] };
		return {
			...(brief.traceStartWallMs === undefined ? {} : { traceStartWallMs: brief.traceStartWallMs }),
			hangs: brief.hangs,
			topFunctions: brief.topFunctions.slice(0, 10),
		};
	}

	nativeSummaryOf(
		platform: "ios" | "android",
		analysis: NativeAnalysis,
		handleStartWallMs?: number
	): NativeSummaryFile {
		return {
			version: 1,
			platform,
			...this.nativeBrief(platform, analysis.report, handleStartWallMs),
			findings: analysis.findings,
			summary: analysis.summary,
			section: analysis.section,
			files: analysis.files,
		};
	}

	writeNativeSummary(ctx: Pick<PerfEnv, "env">, id: string, file: NativeSummaryFile): void {
		mkdirSync(join(perfPaths.sessionDir(ctx, id), "native"), { recursive: true });
		perfDeviceState.writeFileAtomic(
			join(perfPaths.sessionDir(ctx, id), NATIVE_SUMMARY),
			`${JSON.stringify(file, null, 2)}\n`
		);
	}

	private readNative(dir: string): NativeInput | undefined {
		const raw = this.readJson(join(dir, NATIVE_SUMMARY));
		if (!this.isRecord(raw) || raw.version !== 1) return undefined;
		const platform = raw.platform === "ios" || raw.platform === "android" ? raw.platform : undefined;
		const section = this.isRecord(raw.section) ? raw.section : undefined;
		if (platform === undefined || section === undefined) return undefined;
		const hangs: NativeHangBrief[] = this.arr(raw.hangs).flatMap((h) =>
			this.isRecord(h) && this.num(h.atMs) !== undefined && this.num(h.durationMs) !== undefined
				? [{ atMs: this.num(h.atMs) ?? 0, durationMs: this.num(h.durationMs) ?? 0, kind: this.str(h.kind) ?? "hang" }]
				: []
		);
		const topFunctions = this.arr(raw.topFunctions).flatMap((f) =>
			this.isRecord(f) && this.str(f.name) !== undefined && this.num(f.selfPct) !== undefined
				? [{ name: this.str(f.name) ?? "", selfPct: this.num(f.selfPct) ?? 0 }]
				: []
		);
		const sectionLines: ReportSection = {
			title: this.str(section.title) ?? "Native CPU",
			lines: this.arr(section.lines).filter((l): l is string => typeof l === "string"),
		};
		return {
			platform,
			...(this.num(raw.traceStartWallMs) === undefined
				? {}
				: { traceStartWallMs: this.num(raw.traceStartWallMs) ?? 0 }),
			hangs,
			topFunctions,
			findings: this.arr(raw.findings).filter(this.isRecord) as unknown as Finding[],
			summary: this.arr(raw.summary).filter((l): l is string => typeof l === "string"),
			section: sectionLines,
		};
	}

	private readStartup(dir: string): StartupInput | undefined {
		const raw = this.readJson(join(dir, "metrics", "startup.json"));
		if (!this.isRecord(raw) || this.str(raw.method) === undefined || !this.isRecord(raw.summary)) return undefined;
		const pick = (k: "cold" | "warm") => {
			const s = raw.summary;
			const v = this.isRecord(s) ? s[k] : undefined;
			return this.isRecord(v) && this.num(v.medianMs) !== undefined
				? {
						runs: this.num(v.runs) ?? 1,
						medianMs: this.num(v.medianMs) ?? 0,
						p90Ms: this.num(v.p90Ms) ?? 0,
						minMs: this.num(v.minMs) ?? 0,
						maxMs: this.num(v.maxMs) ?? 0,
					}
				: undefined;
		};
		const cold = pick("cold");
		const warm = pick("warm");
		return {
			method: this.str(raw.method) ?? "",
			summary: { ...(cold === undefined ? {} : { cold }), ...(warm === undefined ? {} : { warm }) },
			findings: this.arr(raw.findings).filter(this.isRecord) as unknown as Finding[],
			notes: this.arr(raw.notes).filter((n): n is string => typeof n === "string"),
		};
	}

	private readFrames(dir: string): FramesInput | undefined {
		const raw = this.readJson(join(dir, "frames.json"));
		if (!this.isRecord(raw) || raw.status !== "ok") return undefined;
		return raw as unknown as FramesInput;
	}

	private readHotspots(dir: string): Hotspots | undefined {
		const raw = this.readJson(join(dir, "js", "hotspots.json"));
		return this.isRecord(raw) && raw.version === 1 && Array.isArray(raw.topSelf)
			? (raw as unknown as Hotspots)
			: undefined;
	}

	/** `react/commits.json` parsed, for queries and the merger. */
	readCommitsFile(dir: string): CommitsFile | undefined {
		const parsed = commitsFileSchema.safeParse(this.readJson(join(dir, "react", "commits.json")));
		return parsed.success ? parsed.data : undefined;
	}

	private readReact(dir: string): ReportInput["react"] {
		const raw = this.readJson(join(dir, "react", "findings.json"));
		const file = this.readCommitsFile(dir);
		if (!this.isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.findings)) return undefined;
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

	private readCrashes(dir: string): CrashesInput | undefined {
		const raw = this.readJson(join(dir, CRASH_SUMMARY));
		if (!this.isRecord(raw)) return undefined;
		return {
			count: this.num(raw.count) ?? 0,
			lines: this.arr(raw.lines).filter((l): l is string => typeof l === "string"),
			findings: this.arr(raw.findings).filter(this.isRecord) as unknown as Finding[],
		};
	}

	/** Everything the merger needs, read from the session directory. Capturers that left nothing are simply absent. */
	loadReportInput(ctx: Pick<PerfEnv, "env" | "now">, session: PerfSession): ReportInput {
		const dir = perfPaths.sessionDir(ctx, session.id);
		const samples = sampleSeries.decodeSamples(this.readText(join(dir, "metrics", "samples.jsonl")) ?? "");
		const metrics = sampleSeries.summarize(samples);
		const logText = this.readText(join(dir, "logs", "device.log"));
		const startup = this.readStartup(dir);
		const frames = this.readFrames(dir);
		const js = this.readHotspots(dir);
		const react = this.readReact(dir);
		const native = this.readNative(dir);
		const crashes = this.readCrashes(dir);
		return {
			session,
			now: ctx.now(),
			...(startup === undefined ? {} : { startup }),
			...(frames === undefined ? {} : { frames }),
			...(metrics === undefined ? {} : { metrics }),
			...(js === undefined ? {} : { js }),
			...(react === undefined ? {} : { react }),
			...(native === undefined ? {} : { native }),
			...(logText === undefined ? {} : { logs: reportBuilder.summarizeLogs(logText) }),
			...(crashes === undefined ? {} : { crashes }),
		};
	}

	/** Merge the session's files into `report.json` + `report.md` (full markdown) in its directory. */
	writeSessionReport(ctx: Pick<PerfEnv, "env" | "now">, session: PerfSession): PerfReportJson {
		const report = reportBuilder.buildReport(this.loadReportInput(ctx, session));
		const dir = perfPaths.sessionDir(ctx, session.id);
		perfDeviceState.writeFileAtomic(join(dir, REPORT_JSON), `${JSON.stringify(report, null, 2)}\n`);
		perfDeviceState.writeFileAtomic(join(dir, REPORT_MD), `${reportBuilder.renderReportMarkdown(report)}\n`);
		return report;
	}

	/** A session's `report.json`, as written (undefined when the session has none yet or it does not parse). */
	readSessionReport(ctx: Pick<PerfEnv, "env">, id: string): PerfReportJson | undefined {
		const raw = this.readJson(join(perfPaths.sessionDir(ctx, id), REPORT_JSON));
		return this.isRecord(raw) &&
			raw.version === 1 &&
			this.str(raw.sessionId) !== undefined &&
			this.isRecord(raw.metrics)
			? (raw as unknown as PerfReportJson)
			: undefined;
	}

	/** The report for `id`: the written one, else built (and written) from its files. */
	reportFor(ctx: Pick<PerfEnv, "env" | "now">, id: string): PerfReportJson | undefined {
		const written = this.readSessionReport(ctx, id);
		if (written !== undefined) return written;
		const session = perfSessionStore.readSession(ctx, id);
		return session === undefined ? undefined : this.writeSessionReport(ctx, session);
	}
}

export const reportReader = new ReportReader();
