import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { iosAnalyzer, type NativeReport } from "@delacour/warden-perf/ios/analyze";
import { instrumentChecker } from "@delacour/warden-perf/ios/instruments";
import { iosTraceAnalyzer, type TraceDeps } from "@delacour/warden-perf/ios/trace";
import {
	HANGS_INSTRUMENT,
	LEAK_INSTRUMENTS,
	type RecordTarget,
	xctraceArgv,
} from "@delacour/warden-perf/ios/xctrace-argv";
import { doctorParser } from "@delacour/warden-perf/shared/doctor-parse";
import { iosAppLaunch } from "@delacour/warden-perf/startup/ios-app-launch";
import { type PidIdentity, processIdentity } from "@delacour/warden-store/process-identity";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opErrors } from "../errors";
import { appProcess } from "./app-process";
import type { PerfUiEnv } from "./env";
import { nativeStateFiles } from "./native-state";
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
import { appRelauncher } from "./relaunch";

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

type Chosen = { instruments: string[]; warnings: string[] };

type Prepared = { recordTarget: RecordTarget; launchAfterArm: boolean; appPid?: number };

export type AnalyzeTraceFile = { trace: string; dir: string; pid?: number; traceStartWallMs?: number };

/** IosNativeCapture: native ios. */
export class IosNativeCapture {
	private readonly fail = (error: WardenError): { success: false; error: WardenError } => ({ success: false, error });

	private readonly failed = (message: string, hint?: string): { success: false; error: WardenError } =>
		this.fail(opErrors.opError("failed", message, hint === undefined ? {} : { hint }));

	/** Xcode 26.4+ deadlocks `xctrace record --device`; an unreadable version assumes the plain path. */
	private async deviceDeadlock(ctx: PerfUiEnv): Promise<boolean> {
		const res = await ctx.exec(["xcodebuild", "-version"], { timeoutMs: 15_000 });
		const version = res.exitCode === 0 ? doctorParser.parseXcodeVersion(res.stdout) : undefined;
		return version !== undefined && doctorParser.xctraceDeviceDeadlock(version);
	}

	/** The instruments to record with, verified against `xctrace list instruments`; a missing Hangs/Leaks is an error naming alternatives. */
	private async chooseInstruments(ctx: PerfUiEnv, leaks: boolean): Promise<Result<Chosen, WardenError>> {
		const wanted = [HANGS_INSTRUMENT, ...(leaks ? LEAK_INSTRUMENTS : [])];
		const check = await instrumentChecker.checkXctraceInstruments(
			(argv) => ctx.exec(argv, { timeoutMs: 20_000 }),
			wanted
		);
		if (check === undefined) {
			return this.fail(
				opErrors.opError("tool_missing", "xcrun xctrace is unavailable or failed to list instruments", {
					hint: "install Xcode and run `xcode-select -s /Applications/Xcode.app`; warden perf doctor checks it",
				})
			);
		}
		if (check.ok) return resultFactory.ok({ instruments: wanted, warnings: [] });
		const required = check.missing.filter((m) => m !== "Allocations");
		if (required.length > 0) {
			const lines = required.map((m) => {
				const alt = check.alternatives[m] ?? [];
				return `${m}${alt.length > 0 ? ` (try: ${alt.join(", ")})` : ""}`;
			});
			return this.fail(
				opErrors.opError("unsupported", `this Xcode's xctrace has no instrument: ${lines.join("; ")}`, {
					hint: "`xcrun xctrace list instruments` shows what is available; update Xcode or file an issue",
				})
			);
		}
		return resultFactory.ok({
			instruments: wanted.filter((w) => !check.missing.includes(w)),
			warnings: [`instrument ${check.missing.join(", ")} is not available: recording without it`],
		});
	}

	private async startRecorder(
		io: NativeIo,
		argv: string[],
		dir: string,
		fs: IosNativeFs,
		out: string
	): Promise<Result<number, WardenError>> {
		fs.mkdir(dir);
		fs.remove(out);
		const logPath = join(dir, LOG_FILE);
		const { pid } = io.spawnDetached({ argv, logPath });
		await io.sleep(STARTUP_GRACE_MS);
		if (!io.pidAlive(pid)) {
			const log = fs.readText(logPath).trim().split("\n").slice(-4).join(" | ");
			return this.failed(`xctrace exited right after starting${log === "" ? "" : `: ${log}`}`, `see ${logPath}`);
		}
		return resultFactory.ok(pid);
	}

	/** `--leaks`: terminate the app so the profiler can cold-launch it (or arm all-processes when the host deadlocks). */
	private async prepareLeaks(
		ctx: PerfUiEnv,
		udid: string,
		app: string,
		deadlock: boolean
	): Promise<Result<Prepared, WardenError>> {
		const device = { platform: "ios" as const, id: udid };
		const bundle = await appProcess.iosAppBundle(ctx, udid, app);
		if (!bundle.success) return bundle;
		const stopped = await appRelauncher.terminateApp(ctx, device, app);
		if (!stopped.success) return stopped;
		if (deadlock) return resultFactory.ok({ recordTarget: { kind: "all-processes" }, launchAfterArm: true });
		return resultFactory.ok({
			recordTarget: { kind: "launch", udid, appPath: bundle.data.appPath, env: { MallocStackLogging: "1" } },
			launchAfterArm: false,
		});
	}

	/** Default: attach to the running app (or arm all-processes when the host deadlocks). */
	private async prepareAttach(
		ctx: PerfUiEnv,
		udid: string,
		app: string,
		deadlock: boolean
	): Promise<Result<Prepared, WardenError>> {
		const pid = await appProcess.appPid(ctx, { platform: "ios" as const, id: udid }, app);
		if (pid === undefined) {
			return this.fail(
				opErrors.opError("app_not_found", `${app} is not running on ${udid}`, {
					hint: "launch the app first (warden ui open <bundleId>), or pass --leaks to cold-launch it under the profiler",
				})
			);
		}
		const recordTarget: RecordTarget = deadlock ? { kind: "all-processes" } : { kind: "attach", udid, pid };
		return resultFactory.ok({ recordTarget, launchAfterArm: false, appPid: pid });
	}

	/** All-processes leaks mode: launch the app once the recorder is armed; returns its pid, killing the recorder on failure. */
	private async launchAfterArming(
		ctx: PerfUiEnv,
		io: NativeIo,
		udid: string,
		app: string,
		recorderPid: number
	): Promise<Result<number, WardenError>> {
		await io.sleep(ARM_MS);
		const launched = await ctx.exec(["xcrun", "simctl", "launch", udid, app], {
			timeoutMs: 60_000,
			env: { SIMCTL_CHILD_MallocStackLogging: "1" },
		});
		const appPidNow = launched.exitCode === 0 ? iosAppLaunch.parseSimctlLaunch(launched.stdout) : undefined;
		if (appPidNow === undefined) {
			io.kill(recorderPid, "SIGKILL");
			return this.failed(`simctl launch ${app} failed: ${(launched.stderr || launched.stdout).trim()}`);
		}
		return resultFactory.ok(appPidNow);
	}

	private async start(
		ctx: PerfUiEnv,
		io: NativeIo,
		fs: IosNativeFs,
		input: NativeStartInput
	): Promise<Result<NativeHandle, WardenError>> {
		const { target, app, dir } = input;
		const deadlock = await this.deviceDeadlock(ctx);
		const chosen = await this.chooseInstruments(ctx, input.leaks);
		if (!chosen.success) return chosen;
		const out = join(dir, TRACE_FILE);
		const state: Record<string, string | number | boolean> = { allProcesses: deadlock, leaks: input.leaks };
		const prepared = await (input.leaks
			? this.prepareLeaks(ctx, target.udid, app, deadlock)
			: this.prepareAttach(ctx, target.udid, app, deadlock));
		if (!prepared.success) return prepared;
		if (prepared.data.appPid !== undefined) state.appPid = prepared.data.appPid;

		const argv = xctraceArgv.recordArgv({
			output: out,
			instruments: chosen.data.instruments,
			target: prepared.data.recordTarget,
			timeLimitMs: input.maxDurationMs,
		});
		const startedAtIso = new Date(ctx.now()).toISOString();
		const startWallMs = ctx.now();
		const pid = await this.startRecorder(io, argv, dir, fs, out);
		if (!pid.success) return pid;

		if (prepared.data.launchAfterArm) {
			const launched = await this.launchAfterArming(ctx, io, target.udid, app, pid.data);
			if (!launched.success) return launched;
			state.appPid = launched.data;
		}
		return resultFactory.ok({ pid: pid.data, out, startedAtIso, startWallMs, state });
	}

	/** SIGINT the recorder (only while it is provably the xctrace warden started), wait for the trace to be finalised, SIGKILL on timeout. */
	private async stopRecorder(io: NativeIo, handle: NativeHandle): Promise<string[]> {
		const warnings: string[] = [];
		const { pid } = handle;
		if (pid === undefined) return warnings;
		const identity: PidIdentity = { pidAlive: io.pidAlive, command: io.command };
		const marks = ["xctrace", handle.out];
		if (!io.pidAlive(pid)) return warnings;
		if (!processIdentity.safeToSignal(identity, pid, marks)) {
			warnings.push(`pid ${pid} is no longer the xctrace warden started: not signalled`);
			return warnings;
		}
		io.kill(pid, "SIGINT");
		let waited = 0;
		while (io.pidAlive(pid) && waited < STOP_WAIT_MS) {
			await io.sleep(POLL_MS);
			waited += POLL_MS;
		}
		if (io.pidAlive(pid) && processIdentity.safeToSignal(identity, pid, marks)) {
			io.kill(pid, "SIGKILL");
			warnings.push("xctrace ignored SIGINT and was killed: the trace may be unfinished");
		}
		return warnings;
	}

	private traceDeps(ctx: PerfUiEnv, fs: IosNativeFs): TraceDeps {
		return {
			run: (argv) => ctx.exec(argv, { timeoutMs: EXPORT_TIMEOUT_MS }),
			readChunks: fs.readChunks,
			remove: fs.remove,
		};
	}

	/** Export a finished `.trace`, analyze it, and write `ios-native.json` beside it. */
	async analyzeTraceFile(
		ctx: PerfUiEnv,
		fs: IosNativeFs,
		input: AnalyzeTraceFile
	): Promise<Result<NativeAnalysis, WardenError>> {
		const workDir = join(input.dir, ".export");
		fs.mkdir(workDir);
		try {
			const res = await iosTraceAnalyzer.analyzeTrace(this.traceDeps(ctx, fs), input.trace, {
				workDir,
				...(input.pid === undefined ? {} : { pid: input.pid }),
				...(input.traceStartWallMs === undefined ? {} : { traceStartWallMs: input.traceStartWallMs }),
			});
			if (!res.success) {
				return this.fail(
					opErrors.opError("failed", res.error.message, res.error.hint === undefined ? {} : { hint: res.error.hint })
				);
			}
			return resultFactory.ok(this.toAnalysis(res.data, input, fs));
		} finally {
			fs.remove(workDir);
		}
	}

	private toAnalysis(report: NativeReport, input: AnalyzeTraceFile, fs: IosNativeFs): NativeAnalysis {
		const file = join(input.dir, ANALYSIS_FILE);
		fs.writeText(file, `${JSON.stringify(report, null, 2)}\n`);
		const worst = report.hangs[0];
		const summary = [
			`native: ${report.hotspots.length} hotspot${report.hotspots.length === 1 ? "" : "s"}, ${report.hangs.length} hang${report.hangs.length === 1 ? "" : "s"}${worst === undefined ? "" : ` (worst ${worst.durationMs}ms)`}, ${report.leaks.length} leak group${report.leaks.length === 1 ? "" : "s"}`,
		];
		return {
			findings: iosAnalyzer.reportFindings(report, input.trace),
			section: iosAnalyzer.reportSection(report),
			summary,
			files: { trace: input.trace, analysis: file },
			report,
			warnings: report.warnings,
		};
	}

	private async stop(
		ctx: PerfUiEnv,
		io: NativeIo,
		fs: IosNativeFs,
		input: NativeStopInput
	): Promise<Result<NativeStopped, WardenError>> {
		const warnings = await this.stopRecorder(io, input.handle);
		const { out } = input.handle;
		if (!fs.exists(out)) {
			const log = fs.readText(join(input.dir, LOG_FILE)).trim().split("\n").slice(-4).join(" | ");
			return this.failed(
				`xctrace wrote no trace at ${out}${log === "" ? "" : `: ${log}`}`,
				`see ${join(input.dir, LOG_FILE)}`
			);
		}
		if (!input.analyze) return resultFactory.ok({ out, warnings });
		const pid =
			typeof input.handle.state?.appPid === "number" && input.handle.state.allProcesses === true
				? input.handle.state.appPid
				: undefined;
		const analysis = await this.analyzeTraceFile(ctx, fs, {
			trace: out,
			dir: input.dir,
			...(pid === undefined ? {} : { pid }),
			traceStartWallMs: input.handle.startWallMs,
		});
		if (!analysis.success) {
			return resultFactory.ok({ out, warnings: [...warnings, `analysis failed: ${analysis.error.message}`] });
		}
		return resultFactory.ok({ out, analysis: analysis.data, warnings: [...warnings, ...analysis.data.warnings] });
	}

	private async analyze(
		ctx: PerfUiEnv,
		fs: IosNativeFs,
		input: NativeAnalyzeInput
	): Promise<Result<NativeAnalysis, WardenError>> {
		if (!fs.exists(input.trace)) return this.fail(opErrors.opError("usage", `no such trace: ${input.trace}`));
		const side = nativeStateFiles.readHandleFile(dirname(input.trace));
		const state = side?.handle.state;
		const pid = typeof state?.appPid === "number" && state.allProcesses === true ? state.appPid : undefined;
		return this.analyzeTraceFile(ctx, fs, {
			trace: input.trace,
			dir: input.dir,
			...(pid === undefined ? {} : { pid }),
			...(side === undefined ? {} : { traceStartWallMs: side.handle.startWallMs }),
		});
	}

	/** iOS simulator profiler: `xctrace record` (Time Profiler + Hangs, + Leaks/Allocations with `--leaks`) and a streaming export analysis. */
	createIosNativeProfiler(fs: IosNativeFs = defaultIosNativeFs): NativeProfiler {
		return {
			start: (ctx, _deps, io, input) => this.start(ctx, io, fs, input),
			stop: (ctx, _deps, io, input) => this.stop(ctx, io, fs, input),
			analyze: (ctx, _deps, input) => this.analyze(ctx, fs, input),
		};
	}
}

export const iosNativeCapture = new IosNativeCapture();

export const iosNativeProfiler: NativeProfiler = iosNativeCapture.createIosNativeProfiler();
