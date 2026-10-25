import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type NativeReport, reportFindings, reportSection } from "@delacour/warden-perf/ios/analyze";
import { checkXctraceInstruments } from "@delacour/warden-perf/ios/instruments";
import { analyzeTrace, type TraceDeps } from "@delacour/warden-perf/ios/trace";
import {
	HANGS_INSTRUMENT,
	LEAK_INSTRUMENTS,
	type RecordTarget,
	recordArgv,
} from "@delacour/warden-perf/ios/xctrace-argv";
import { parseXcodeVersion, xctraceDeviceDeadlock } from "@delacour/warden-perf/shared/doctor-parse";
import { parseSimctlLaunch } from "@delacour/warden-perf/startup/ios-app-launch";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import { type PidIdentity, safeToSignal } from "../agent-ui/process-identity";
import type { CommandContext } from "../context";
import { appPid, iosAppBundle } from "./app-process";
import { readHandleFile } from "./native-state";
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
import { terminateApp } from "./relaunch";

export const TRACE_FILE = "ios.trace";
export const ANALYSIS_FILE = "ios-native.json";
const LOG_FILE = "xctrace.log";
/** how long `stop` waits for xctrace to finalise the trace after SIGINT before killing it */
export const STOP_WAIT_MS = 60_000;
const POLL_MS = 250;
/** the recorder gets this long to fail fast (bad pid, privacy prompt, deadlock) before `start` reports success */
const STARTUP_GRACE_MS = 1500;
/** the recorder is up before the app is launched under it */
const ARM_MS = 2000;
const EXPORT_TIMEOUT_MS = 10 * 60_000;

/** Files the iOS profiler touches; tests inject fakes. */
export type IosNativeFs = {
	exists: (path: string) => boolean;
	readText: (path: string) => string;
	readChunks: (path: string) => AsyncIterable<string>;
	remove: (path: string) => void;
	mkdir: (path: string) => void;
	writeText: (path: string, text: string) => void;
};

export const defaultIosNativeFs: IosNativeFs = {
	exists: existsSync,
	readText: (path) => {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return "";
		}
	},
	readChunks: (path) => createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 20 }),
	remove: (path) => rmSync(path, { recursive: true, force: true }),
	mkdir: (path) => void mkdirSync(path, { recursive: true }),
	writeText: (path, text) => writeFileSync(path, text),
};

const fail = (error: UiError): { success: false; error: UiError } => ({ success: false, error });

const failed = (message: string, hint?: string): { success: false; error: UiError } =>
	fail(uiError("failed", message, hint === undefined ? {} : { hint }));

/** Xcode 26.4+ deadlocks `xctrace record --device`; an unreadable version assumes the plain path. */
async function deviceDeadlock(ctx: CommandContext): Promise<boolean> {
	const res = await ctx.exec(["xcodebuild", "-version"], { timeoutMs: 15_000 });
	const version = res.exitCode === 0 ? parseXcodeVersion(res.stdout) : undefined;
	return version !== undefined && xctraceDeviceDeadlock(version);
}

type Chosen = { instruments: string[]; warnings: string[] };

/** The instruments to record with, verified against `xctrace list instruments`; a missing Hangs/Leaks is an error naming alternatives. */
async function chooseInstruments(ctx: CommandContext, leaks: boolean): Promise<Result<Chosen, UiError>> {
	const wanted = [HANGS_INSTRUMENT, ...(leaks ? LEAK_INSTRUMENTS : [])];
	const check = await checkXctraceInstruments((argv) => ctx.exec(argv, { timeoutMs: 20_000 }), wanted);
	if (check === undefined) {
		return fail(
			uiError("tool_missing", "xcrun xctrace is unavailable or failed to list instruments", {
				hint: "install Xcode and run `xcode-select -s /Applications/Xcode.app`; warden perf doctor checks it",
			})
		);
	}
	if (check.ok) return ok({ instruments: wanted, warnings: [] });
	const required = check.missing.filter((m) => m !== "Allocations");
	if (required.length > 0) {
		const lines = required.map((m) => {
			const alt = check.alternatives[m] ?? [];
			return `${m}${alt.length > 0 ? ` (try: ${alt.join(", ")})` : ""}`;
		});
		return fail(
			uiError("unsupported", `this Xcode's xctrace has no instrument: ${lines.join("; ")}`, {
				hint: "`xcrun xctrace list instruments` shows what is available; update Xcode or file an issue",
			})
		);
	}
	return ok({
		instruments: wanted.filter((w) => !check.missing.includes(w)),
		warnings: [`instrument ${check.missing.join(", ")} is not available: recording without it`],
	});
}

async function startRecorder(
	io: NativeIo,
	argv: string[],
	dir: string,
	fs: IosNativeFs,
	out: string
): Promise<Result<number, UiError>> {
	fs.mkdir(dir);
	fs.remove(out);
	const logPath = join(dir, LOG_FILE);
	const { pid } = io.spawnDetached({ argv, logPath });
	await io.sleep(STARTUP_GRACE_MS);
	if (!io.pidAlive(pid)) {
		const log = fs.readText(logPath).trim().split("\n").slice(-4).join(" | ");
		return failed(`xctrace exited right after starting${log === "" ? "" : `: ${log}`}`, `see ${logPath}`);
	}
	return ok(pid);
}

async function start(
	ctx: CommandContext,
	io: NativeIo,
	fs: IosNativeFs,
	input: NativeStartInput
): Promise<Result<NativeHandle, UiError>> {
	const { target, app, dir } = input;
	const device = { platform: "ios" as const, id: target.udid };
	const deadlock = await deviceDeadlock(ctx);
	const chosen = await chooseInstruments(ctx, input.leaks);
	if (!chosen.success) return chosen;
	const out = join(dir, TRACE_FILE);
	const state: Record<string, string | number | boolean> = { allProcesses: deadlock, leaks: input.leaks };
	let recordTarget: RecordTarget;
	let launchAfterArm = false;

	if (input.leaks) {
		const bundle = await iosAppBundle(ctx, target.udid, app);
		if (!bundle.success) return bundle;
		const stopped = await terminateApp(ctx, device, app);
		if (!stopped.success) return stopped;
		if (deadlock) {
			recordTarget = { kind: "all-processes" };
			launchAfterArm = true;
		} else {
			recordTarget = {
				kind: "launch",
				udid: target.udid,
				appPath: bundle.data.appPath,
				env: { MallocStackLogging: "1" },
			};
		}
	} else {
		const pid = await appPid(ctx, device, app);
		if (pid === undefined) {
			return fail(
				uiError("app_not_found", `${app} is not running on ${target.udid}`, {
					hint: "launch the app first (warden ui open <bundleId>), or pass --leaks to cold-launch it under the profiler",
				})
			);
		}
		state.appPid = pid;
		recordTarget = deadlock ? { kind: "all-processes" } : { kind: "attach", udid: target.udid, pid };
	}

	const argv = recordArgv({
		output: out,
		instruments: chosen.data.instruments,
		target: recordTarget,
		timeLimitMs: input.maxDurationMs,
	});
	const startedAtIso = new Date(ctx.now()).toISOString();
	const startWallMs = ctx.now();
	const pid = await startRecorder(io, argv, dir, fs, out);
	if (!pid.success) return pid;

	if (launchAfterArm) {
		await io.sleep(ARM_MS);
		const launched = await ctx.exec(["xcrun", "simctl", "launch", target.udid, app], {
			timeoutMs: 60_000,
			env: { SIMCTL_CHILD_MallocStackLogging: "1" },
		});
		const appPidNow = launched.exitCode === 0 ? parseSimctlLaunch(launched.stdout) : undefined;
		if (appPidNow === undefined) {
			io.kill(pid.data, "SIGKILL");
			return failed(`simctl launch ${app} failed: ${(launched.stderr || launched.stdout).trim()}`);
		}
		state.appPid = appPidNow;
	}
	return ok({ pid: pid.data, out, startedAtIso, startWallMs, state });
}

/** SIGINT the recorder (only while it is provably the xctrace warden started), wait for the trace to be finalised, SIGKILL on timeout. */
async function stopRecorder(io: NativeIo, handle: NativeHandle): Promise<string[]> {
	const warnings: string[] = [];
	const { pid } = handle;
	if (pid === undefined) return warnings;
	const identity: PidIdentity = { pidAlive: io.pidAlive, command: io.command };
	const marks = ["xctrace", handle.out];
	if (!io.pidAlive(pid)) return warnings;
	if (!safeToSignal(identity, pid, marks)) {
		warnings.push(`pid ${pid} is no longer the xctrace warden started: not signalled`);
		return warnings;
	}
	io.kill(pid, "SIGINT");
	let waited = 0;
	while (io.pidAlive(pid) && waited < STOP_WAIT_MS) {
		await io.sleep(POLL_MS);
		waited += POLL_MS;
	}
	if (io.pidAlive(pid) && safeToSignal(identity, pid, marks)) {
		io.kill(pid, "SIGKILL");
		warnings.push("xctrace ignored SIGINT and was killed: the trace may be unfinished");
	}
	return warnings;
}

function traceDeps(ctx: CommandContext, fs: IosNativeFs): TraceDeps {
	return {
		run: (argv) => ctx.exec(argv, { timeoutMs: EXPORT_TIMEOUT_MS }),
		readChunks: fs.readChunks,
		remove: fs.remove,
	};
}

export type AnalyzeTraceFile = { trace: string; dir: string; pid?: number; traceStartWallMs?: number };

/** Export a finished `.trace`, analyze it, and write `ios-native.json` beside it. */
export async function analyzeTraceFile(
	ctx: CommandContext,
	fs: IosNativeFs,
	input: AnalyzeTraceFile
): Promise<Result<NativeAnalysis, UiError>> {
	const workDir = join(input.dir, ".export");
	fs.mkdir(workDir);
	try {
		const res = await analyzeTrace(traceDeps(ctx, fs), input.trace, {
			workDir,
			...(input.pid === undefined ? {} : { pid: input.pid }),
			...(input.traceStartWallMs === undefined ? {} : { traceStartWallMs: input.traceStartWallMs }),
		});
		if (!res.success) {
			return fail(uiError("failed", res.error.message, res.error.hint === undefined ? {} : { hint: res.error.hint }));
		}
		return ok(toAnalysis(res.data, input, fs));
	} finally {
		fs.remove(workDir);
	}
}

function toAnalysis(report: NativeReport, input: AnalyzeTraceFile, fs: IosNativeFs): NativeAnalysis {
	const file = join(input.dir, ANALYSIS_FILE);
	fs.writeText(file, `${JSON.stringify(report, null, 2)}\n`);
	const worst = report.hangs[0];
	const summary = [
		`native: ${report.hotspots.length} hotspot${report.hotspots.length === 1 ? "" : "s"}, ${report.hangs.length} hang${report.hangs.length === 1 ? "" : "s"}${worst === undefined ? "" : ` (worst ${worst.durationMs}ms)`}, ${report.leaks.length} leak group${report.leaks.length === 1 ? "" : "s"}`,
	];
	return {
		findings: reportFindings(report, input.trace),
		section: reportSection(report),
		summary,
		files: { trace: input.trace, analysis: file },
		report,
		warnings: report.warnings,
	};
}

async function stop(
	ctx: CommandContext,
	io: NativeIo,
	fs: IosNativeFs,
	input: NativeStopInput
): Promise<Result<NativeStopped, UiError>> {
	const warnings = await stopRecorder(io, input.handle);
	const { out } = input.handle;
	if (!fs.exists(out)) {
		const log = fs.readText(join(input.dir, LOG_FILE)).trim().split("\n").slice(-4).join(" | ");
		return failed(
			`xctrace wrote no trace at ${out}${log === "" ? "" : `: ${log}`}`,
			`see ${join(input.dir, LOG_FILE)}`
		);
	}
	if (!input.analyze) return ok({ out, warnings });
	const pid =
		typeof input.handle.state?.appPid === "number" && input.handle.state.allProcesses === true
			? input.handle.state.appPid
			: undefined;
	const analysis = await analyzeTraceFile(ctx, fs, {
		trace: out,
		dir: input.dir,
		...(pid === undefined ? {} : { pid }),
		traceStartWallMs: input.handle.startWallMs,
	});
	if (!analysis.success) {
		return ok({ out, warnings: [...warnings, `analysis failed: ${analysis.error.message}`] });
	}
	return ok({ out, analysis: analysis.data, warnings: [...warnings, ...analysis.data.warnings] });
}

async function analyze(
	ctx: CommandContext,
	fs: IosNativeFs,
	input: NativeAnalyzeInput
): Promise<Result<NativeAnalysis, UiError>> {
	if (!fs.exists(input.trace)) return fail(uiError("usage", `no such trace: ${input.trace}`));
	const side = readHandleFile(dirname(input.trace));
	const state = side?.handle.state;
	const pid = typeof state?.appPid === "number" && state.allProcesses === true ? state.appPid : undefined;
	return analyzeTraceFile(ctx, fs, {
		trace: input.trace,
		dir: input.dir,
		...(pid === undefined ? {} : { pid }),
		...(side === undefined ? {} : { traceStartWallMs: side.handle.startWallMs }),
	});
}

/** iOS simulator profiler: `xctrace record` (Time Profiler + Hangs, + Leaks/Allocations with `--leaks`) and a streaming export analysis. */
export function createIosNativeProfiler(fs: IosNativeFs = defaultIosNativeFs): NativeProfiler {
	return {
		start: (ctx, _deps, io, input) => start(ctx, io, fs, input),
		stop: (ctx, _deps, io, input) => stop(ctx, io, fs, input),
		analyze: (ctx, _deps, input) => analyze(ctx, fs, input),
	};
}

export const iosNativeProfiler: NativeProfiler = createIosNativeProfiler();
