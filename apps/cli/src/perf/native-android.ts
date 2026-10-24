import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExecResult } from "@delacour/warden-core/exec";
import { androidTools } from "@delacour/warden-core/providers/android";
import {
	analyzeCpu,
	analyzeHangs,
	analyzeRss,
	analyzeThreads,
	type CpuAnalysis,
	cpuFindings,
	describeBuckets,
	type HangAnalysis,
	hangFindings,
	type RssAnalysis,
	rssFindings,
	type ThreadBreakdown,
} from "@delacour/warden-perf/android/analyze";
import {
	aliveArgv,
	killArgv,
	parsePerfettoPid,
	perfettoStartArgv,
	pullArgv,
	remoteSimpleperfPath,
	remoteTracePath,
	removeArgv,
	SIMPLEPERF_HZ,
	simpleperfReportArgv,
	simpleperfStartArgv,
} from "@delacour/warden-perf/android/capture";
import { buildPerfettoConfig, DEFAULT_SAMPLE_HZ } from "@delacour/warden-perf/android/perfetto.config";
import { type QueryName, renderQuery } from "@delacour/warden-perf/android/queries";
import { parseSimpleperfReport, simpleperfFindings } from "@delacour/warden-perf/android/simpleperf";
import { parseTpOutput, type TpRow } from "@delacour/warden-perf/android/tp-output";
import { parsePackageFlags } from "@delacour/warden-perf/shared/app-detect";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { appPid } from "./app-process";
import type {
	NativeAnalysis,
	NativeAnalyzeInput,
	NativeHandle,
	NativeIo,
	NativeProfiler,
	NativeStartInput,
	NativeStopInput,
	NativeStopped,
} from "./native-types";
import type { PerfDeps } from "./run";
import { defaultTraceProcessorDeps, resolveTraceProcessor, type TraceProcessorDeps } from "./trace-processor";

export const PERFETTO_TRACE_FILE = "android.perfetto-trace";
export const SIMPLEPERF_DATA_FILE = "simpleperf.data";
/** `simpleperf report` text, saved beside the data: the device copy is removed, so `analyze` reads this. */
const SIMPLEPERF_REPORT_SUFFIX = ".report.txt";

const MANIFEST_HINT =
	'add <profileable android:shell="true"/> inside <application> in AndroidManifest.xml (or use a debug build), rebuild, and retry';

/** Effects beyond `ctx.exec` / `NativeIo`; tests inject fakes. */
export type AndroidNativeDeps = {
	/** run `argv` with `stdin` piped in (the Perfetto config); `ctx.exec` has no stdin */
	execWithStdin: (argv: readonly string[], stdin: string, timeoutMs: number) => Promise<ExecResult>;
	traceProcessor: TraceProcessorDeps;
	/** how long a recorder gets to flush after a stop signal before the next, harder, one */
	stopTimeoutMs: number;
	pollMs: number;
};

export const defaultAndroidNativeDeps: AndroidNativeDeps = {
	execWithStdin: async (argv, stdin, timeoutMs) => {
		try {
			const proc = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
			proc.stdin.write(stdin);
			await proc.stdin.end();
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { exitCode, stdout, stderr };
		} catch (error) {
			return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
		}
	},
	traceProcessor: defaultTraceProcessorDeps,
	stopTimeoutMs: 30_000,
	pollMs: 250,
};

type Adb = { adb: string; serial: string };

const failed = (message: string, hint?: string): { success: false; error: UiError } => ({
	success: false,
	error: uiError("failed", message, hint === undefined ? {} : { hint }),
});

const tail = (r: ExecResult): string => (r.stderr || r.stdout).trim().split("\n").slice(-2).join(" | ");

/** Device clock in ms (`date +%s%N`), taken around one round trip: the midpoint of the host clock pairs with it. */
async function deviceClock(ctx: CommandContext, a: Adb): Promise<{ wallMs: number; deviceWallMs?: number }> {
	const before = ctx.now();
	const res = await ctx.exec([a.adb, "-s", a.serial, "shell", "date", "+%s%N"], { timeoutMs: 5_000 });
	const after = ctx.now();
	const ns = /^\d{16,}$/.test(res.stdout.trim()) ? BigInt(res.stdout.trim()) : undefined;
	const wallMs = Math.round((before + after) / 2);
	return ns === undefined || res.exitCode !== 0 ? { wallMs } : { wallMs, deviceWallMs: Number(ns / 1_000_000n) };
}

/** Warn early (stderr) when Android will probably refuse to profile the app. */
async function warnIfNotProfileable(ctx: CommandContext, a: Adb, app: string): Promise<void> {
	const res = await ctx.exec([a.adb, "-s", a.serial, "shell", "dumpsys", "package", app], { timeoutMs: 15_000 });
	if (res.exitCode !== 0) return;
	const flags = parsePackageFlags(res.stdout);
	if (flags.debuggable || flags.profileable) return;
	ctx.err(
		ctx.ui.color.yellow(
			`warden perf native: ${app} is neither debuggable nor profileable; samples may be empty — ${MANIFEST_HINT}`
		)
	);
}

async function waitGone(
	ctx: CommandContext,
	io: NativeIo,
	deps: AndroidNativeDeps,
	a: Adb,
	pid: number,
	timeoutMs: number
): Promise<boolean> {
	const deadline = ctx.now() + timeoutMs;
	for (;;) {
		const res = await ctx.exec(aliveArgv(a, pid), { timeoutMs: 5_000 });
		if (res.exitCode !== 0) return true;
		if (ctx.now() >= deadline) return false;
		await io.sleep(deps.pollMs);
	}
}

/** Signal `pid`, wait for it to leave `/proc`; escalate through `signals`. */
async function stopOnDevice(
	ctx: CommandContext,
	io: NativeIo,
	deps: AndroidNativeDeps,
	a: Adb,
	pid: number,
	signals: ReadonlyArray<"INT" | "TERM" | "KILL">
): Promise<boolean> {
	for (const signal of signals) {
		await ctx.exec(killArgv(a, pid, signal), { timeoutMs: 5_000 });
		if (await waitGone(ctx, io, deps, a, pid, deps.stopTimeoutMs)) return true;
	}
	return false;
}

type State = { mode: "perfetto" | "simpleperf"; devicePid: number; remote: string; hz: number };

function readState(handle: NativeHandle): State | undefined {
	const s = handle.state;
	if (s === undefined) return undefined;
	const { mode, devicePid, remote, hz } = s;
	if ((mode !== "perfetto" && mode !== "simpleperf") || typeof devicePid !== "number" || typeof remote !== "string") {
		return undefined;
	}
	return { mode, devicePid, remote, hz: typeof hz === "number" ? hz : DEFAULT_SAMPLE_HZ };
}

async function startAndroid(
	ctx: CommandContext,
	deps: AndroidNativeDeps,
	input: NativeStartInput
): Promise<Result<NativeHandle, UiError>> {
	const a: Adb = { adb: androidTools(ctx.env).adb, serial: input.target.udid };
	const simpleperf = input.flavor === "simpleperf";
	await warnIfNotProfileable(ctx, a, input.app);
	const clock = await deviceClock(ctx, a);
	const stamp = clock.wallMs;
	const startedAtIso = new Date(clock.wallMs).toISOString();
	mkdirSync(input.dir, { recursive: true });

	if (simpleperf) {
		const pid = await appPid(ctx, { platform: "android", id: a.serial }, input.app);
		if (pid === undefined) {
			return {
				success: false,
				error: uiError("app_not_found", `${input.app} is not running on ${a.serial}`, {
					hint: "launch the app first (warden ui open <app>)",
				}),
			};
		}
		const remote = remoteSimpleperfPath(stamp);
		const res = await ctx.exec(simpleperfStartArgv(a, pid, remote, input.maxDurationMs), { timeoutMs: 15_000 });
		const devicePid = parsePerfettoPid(res.stdout);
		if (res.exitCode !== 0 || devicePid === undefined) {
			return failed(
				`simpleperf did not start: ${tail(res) || "no pid printed"}`,
				"is simpleperf on the device? (warden perf doctor)"
			);
		}
		return ok({
			out: join(input.dir, SIMPLEPERF_DATA_FILE),
			startedAtIso,
			startWallMs: clock.wallMs,
			...(clock.deviceWallMs !== undefined ? { deviceWallMs: clock.deviceWallMs } : {}),
			state: { mode: "simpleperf", devicePid, remote, hz: SIMPLEPERF_HZ },
		});
	}

	const config = buildPerfettoConfig({ packageName: input.app, durationMs: input.maxDurationMs });
	if (config === undefined)
		return { success: false, error: uiError("usage", `"${input.app}" is not an Android package name`) };
	const remote = remoteTracePath(stamp);
	const res = await deps.execWithStdin(perfettoStartArgv(a, remote), config, 30_000);
	const devicePid = parsePerfettoPid(res.stdout);
	if (res.exitCode !== 0 || devicePid === undefined) {
		return failed(
			`perfetto did not start: ${tail(res) || "no pid printed"}`,
			"perfetto needs Android 9+ (warden perf doctor)"
		);
	}
	return ok({
		out: join(input.dir, PERFETTO_TRACE_FILE),
		startedAtIso,
		startWallMs: clock.wallMs,
		...(clock.deviceWallMs !== undefined ? { deviceWallMs: clock.deviceWallMs } : {}),
		state: { mode: "perfetto", devicePid, remote, hz: DEFAULT_SAMPLE_HZ },
	});
}

async function stopAndroid(
	ctx: CommandContext,
	perf: PerfDeps,
	io: NativeIo,
	deps: AndroidNativeDeps,
	input: NativeStopInput
): Promise<Result<NativeStopped, UiError>> {
	const state = readState(input.handle);
	if (state === undefined) return failed("the native capturer has no Android state to stop");
	const a: Adb = { adb: androidTools(ctx.env).adb, serial: input.target.udid };
	const warnings: string[] = [];
	const signals = state.mode === "simpleperf" ? (["INT", "TERM", "KILL"] as const) : (["TERM", "KILL"] as const);
	const gone = await stopOnDevice(ctx, io, deps, a, state.devicePid, signals);
	if (!gone)
		warnings.push(
			`${state.mode} (pid ${state.devicePid}) did not exit after ${signals.join("/")}; the trace may be incomplete`
		);

	mkdirSync(dirname(input.handle.out), { recursive: true });
	const pulled = await ctx.exec(pullArgv(a, state.remote, input.handle.out), { timeoutMs: 120_000 });
	if (pulled.exitCode !== 0 || !existsSync(input.handle.out)) {
		return failed(
			`could not pull ${state.remote}: ${tail(pulled)}`,
			"the recorder may have exited before writing; retry with a longer --max-duration"
		);
	}
	if (state.mode === "simpleperf") {
		const report = await ctx.exec(simpleperfReportArgv(a, state.remote), { timeoutMs: 120_000 });
		if (report.exitCode === 0) writeFileSync(`${input.handle.out}${SIMPLEPERF_REPORT_SUFFIX}`, report.stdout);
		else warnings.push(`simpleperf report failed: ${tail(report)}`);
	}
	await ctx.exec(removeArgv(a, state.remote), { timeoutMs: 10_000 });

	if (!input.analyze) return ok({ out: input.handle.out, warnings });
	const analysis = await analyzeAndroid(ctx, perf, deps, {
		target: input.target,
		app: input.app,
		dir: input.dir,
		trace: input.handle.out,
		yes: wantsYes(ctx, input),
		hz: state.hz,
	});
	if (!analysis.success) {
		// The artifact is already on disk; an analysis failure (e.g. no trace_processor) must not lose it.
		return ok({
			out: input.handle.out,
			warnings: [
				...warnings,
				`analysis skipped: ${analysis.error.message}${analysis.error.hint ? ` — ${analysis.error.hint}` : ""}`,
			],
		});
	}
	return ok({ out: input.handle.out, analysis: analysis.data, warnings: [...warnings, ...analysis.data.warnings] });
}

/** `--yes` (download consent): the input's flag when the command passes one, else the raw argv. */
function wantsYes(ctx: CommandContext, input: object): boolean {
	if ("yes" in input && typeof input.yes === "boolean") return input.yes;
	return ctx.argv.includes("--yes") || ctx.argv.includes("-y");
}

function perfettoLines(
	cpu: CpuAnalysis,
	hangs: HangAnalysis,
	rss: RssAnalysis | undefined,
	threads: ThreadBreakdown[]
): string[] {
	const lines: string[] = [`${cpu.totalSamples} CPU samples`];
	lines.push("threads:", ...cpu.threads.slice(0, 5).map((t) => `  ${t.pct.toFixed(1)}%  ${t.thread}`));
	lines.push(
		"top functions:",
		...cpu.functions.slice(0, 10).map((f) => `  ${f.selfPct.toFixed(1)}%  ${f.function}  [${f.thread}]`)
	);
	if (hangs.hangs.length > 0) {
		lines.push(`hangs (${hangs.missedFrames} of ${hangs.totalFrames} frames missed the app deadline):`);
		for (const h of hangs.hangs.slice(0, 5)) {
			lines.push(`  ${fmtMs(h.durMs)} @ ${(h.atMs / 1000).toFixed(1)}s  main: ${describeBuckets(h.main) || "n/a"}`);
		}
	}
	if (rss !== undefined) {
		lines.push(
			`rss: ${(rss.startKb / 1024).toFixed(0)} -> ${(rss.endKb / 1024).toFixed(0)} MB over ${rss.spanSec.toFixed(0)}s (peak ${(rss.peakKb / 1024).toFixed(0)} MB)`
		);
	}
	if (threads.length > 0) {
		lines.push("busiest threads (running / runnable / io):");
		for (const t of threads.slice(0, 5))
			lines.push(`  ${t.thread}: ${fmtMs(t.runningMs)} / ${fmtMs(t.runnableMs)} / ${fmtMs(t.ioMs)}`);
	}
	return lines;
}

type AnalyzeInput = NativeAnalyzeInput & { yes: boolean; hz: number };

const notProfileable = (app: string): UiError =>
	uiError(
		"not_profileable",
		`no CPU samples for ${app}: Android only lets the shell profile debuggable or profileable apps`,
		{
			hint: MANIFEST_HINT,
		}
	);

const fmtMs = (ms: number): string => `${Math.round(ms)}ms`;

async function analyzeSimpleperf(
	app: string,
	trace: string,
	dir: string,
	hz: number
): Promise<Result<NativeAnalysis, UiError>> {
	const reportPath = `${trace}${SIMPLEPERF_REPORT_SUFFIX}`;
	if (!existsSync(reportPath)) {
		return failed(
			`no simpleperf report beside ${trace}`,
			"the report is generated on the device at stop; re-record with --native=simpleperf"
		);
	}
	const report = parseSimpleperfReport(readFileSync(reportPath, "utf8"));
	if (report.samples === 0 || report.rows.length === 0) return { success: false, error: notProfileable(app) };
	const findings = simpleperfFindings(report, hz);
	const top = report.rows.slice(0, 10);
	const lines = top.map((r) => `${r.percent.toFixed(1)}%  ${r.command}  ${r.symbol}  (${r.dso.split("/").pop()})`);
	const out = join(dir, "android-native.json");
	writeFileSync(out, `${JSON.stringify({ mode: "simpleperf", samples: report.samples, top }, null, 2)}\n`);
	return ok({
		findings,
		section: { title: "Native CPU (Android simpleperf)", lines },
		summary: [
			`simpleperf: ${report.samples} samples; hottest ${top[0]?.symbol ?? "n/a"} ${top[0]?.percent.toFixed(1)}%`,
		],
		files: { trace: trace, report: reportPath, analysis: out },
		report: { mode: "simpleperf", samples: report.samples, top },
		warnings: [],
	});
}

async function runQuery(
	ctx: CommandContext,
	tp: string,
	trace: string,
	dir: string,
	name: QueryName,
	app: string
): Promise<Result<TpRow[], UiError>> {
	const sql = renderQuery(name, app);
	if (sql === undefined) return { success: false, error: uiError("usage", `"${app}" is not an Android package name`) };
	const file = join(dir, "queries", `${name}.sql`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, sql);
	const res = await ctx.exec([tp, "--query-file", file, trace], { timeoutMs: 180_000 });
	if (res.exitCode !== 0) return failed(`trace_processor ${name} failed: ${tail(res)}`);
	return ok(parseTpOutput(res.stdout));
}

/** Everything `analyze` reads from the trace, one query per PerfettoSQL file. */
const ANALYSIS_QUERIES = [
	"cpu-hotspots",
	"ui-hangs",
	"hang-folds-batched",
	"thread-breakdown",
	"memory-rss",
] as const satisfies readonly QueryName[];

async function analyzeAndroid(
	ctx: CommandContext,
	_perf: PerfDeps,
	deps: AndroidNativeDeps,
	input: AnalyzeInput
): Promise<Result<NativeAnalysis, UiError>> {
	if (input.trace.endsWith(".data")) return analyzeSimpleperf(input.app, input.trace, input.dir, input.hz);
	if (!existsSync(input.trace)) return failed(`no trace at ${input.trace}`);
	const tp = await resolveTraceProcessor(ctx, deps.traceProcessor, { yes: input.yes });
	if (!tp.success) return tp;

	const rows = {} as Record<(typeof ANALYSIS_QUERIES)[number], TpRow[]>;
	for (const name of ANALYSIS_QUERIES) {
		const res = await runQuery(ctx, tp.data, input.trace, input.dir, name, input.app);
		if (!res.success) return res;
		rows[name] = res.data;
	}

	const cpu = analyzeCpu(rows["cpu-hotspots"]);
	if (cpu.totalSamples === 0) return { success: false, error: notProfileable(input.app) };
	const window = input.windowMs;
	const allHangs = analyzeHangs(rows["ui-hangs"], rows["hang-folds-batched"]);
	const hangs =
		window === undefined
			? allHangs
			: { ...allHangs, hangs: allHangs.hangs.filter((h) => h.atMs >= window.startMs && h.atMs <= window.endMs) };
	const rss = analyzeRss(rows["memory-rss"]);
	const threads = analyzeThreads(rows["thread-breakdown"]);

	const findings: Finding[] = [...cpuFindings(cpu, input.hz), ...hangFindings(hangs), ...rssFindings(rss)];

	const lines = perfettoLines(cpu, hangs, rss, threads);

	const report = {
		mode: "perfetto",
		cpu: { totalSamples: cpu.totalSamples, threads: cpu.threads.slice(0, 10), functions: cpu.functions.slice(0, 25) },
		hangs,
		rss: rss ?? null,
		threads,
	};
	const out = join(input.dir, "android-native.json");
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
	const hottest = cpu.functions[0];
	return ok({
		findings,
		section: { title: "Native CPU (Android Perfetto)", lines },
		summary: [
			`native: ${cpu.totalSamples} samples${hottest ? `; hottest ${hottest.function} ${hottest.selfPct.toFixed(1)}% on ${hottest.thread}` : ""}`,
			...(hangs.missedFrames > 0
				? [`frames: ${hangs.missedFrames} of ${hangs.totalFrames} missed the app deadline`]
				: []),
		],
		files: { trace: input.trace, analysis: out },
		report,
		warnings: [],
	});
}

/** The Android `NativeProfiler`, with its effects injected (tests); `androidNativeProfiler` is the real one. */
export function createAndroidNativeProfiler(deps: AndroidNativeDeps): NativeProfiler {
	return {
		start: (ctx, _perf, _io, input) => startAndroid(ctx, deps, input),
		stop: (ctx, perf, io, input) => stopAndroid(ctx, perf, io, deps, input),
		analyze: (ctx, perf, input) =>
			analyzeAndroid(ctx, perf, deps, {
				...input,
				yes: wantsYes(ctx, input),
				hz: input.trace.endsWith(".data") ? SIMPLEPERF_HZ : DEFAULT_SAMPLE_HZ,
			}),
	};
}

export const androidNativeProfiler: NativeProfiler = createAndroidNativeProfiler(defaultAndroidNativeDeps);
