import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import type { Platform } from "@delacour/warden-core/types";
import { parseDuration } from "@delacour/warden-perf/metrics/duration";
import { HARD_MAX_DURATION_MS, MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import { renderMarkdown, SIMULATOR_BANNER } from "@delacour/warden-perf/shared/render-md";
import type { PerfSession } from "@delacour/warden-perf/shared/session.schema";
import { ok, type Result } from "@delacour/warden-types/result";
import { reportError, reportOk, type UiError, type UiSuccess, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import type { PerfTarget } from "./device";
import {
	findRunningOneShot,
	type HandleFile,
	newOneShotDir,
	readHandleFile,
	sessionNativeDir,
	writeHandleFile,
} from "./native-state";
import {
	defaultNativeIo,
	type NativeAnalysis,
	type NativeHandle,
	type NativeIo,
	type NativeProfiler,
	type NativeStopped,
} from "./native-types";
import { withPerfOptions } from "./options";
import { displayPath } from "./paths";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";
import { activeSessionFor, updateSession } from "./session";

export type { NativeAnalysis, NativeHandle, NativeIo, NativeProfiler } from "./native-types";

export type PerfNativeOptions = PerfOptionValues & {
	duration?: string;
	analyze?: string;
	leaks?: boolean;
	skipAnalysis?: boolean;
	flavor?: string;
	yes?: boolean;
};

const DEFAULT_DURATION_MS = 10_000;
/** headroom past `--duration` before the recorder's own `--time-limit` ends a recording nobody stopped */
const LIMIT_SLACK_MS = 15_000;

/** The profiler for a platform. iOS and Android load lazily so `perf --help` and every other subcommand skip them. */
export type NativeProfilers = Record<Platform, () => Promise<NativeProfiler>>;

export const defaultNativeProfilers: NativeProfilers = {
	ios: async () => (await import("./native-ios")).iosNativeProfiler,
	android: async () => (await import("./native-android")).androidNativeProfiler,
};

/** Where a recording lives: a running session's `native/`, or a one-shot dir. */
export type NativeRun = { dir: string; sessionId?: string; handle: NativeHandle; app: string; leaks: boolean };

export type StartNativeOptions = {
	app: string;
	leaks: boolean;
	flavor?: string;
	maxDurationMs: number;
};

/**
 * Begin a native recording on `target` and persist what `stop` needs (`native/handle.json`, plus a `native` capturer in
 * the device's running session). The capture API `perf start --native` (PRF-9) calls. `--leaks` is a MUTATE (cold launch):
 * the caller resolved `target` in `mutate` mode.
 */
export async function startNative(
	ctx: CommandContext,
	deps: PerfDeps,
	io: NativeIo,
	profilers: NativeProfilers,
	target: PerfTarget,
	opts: StartNativeOptions,
	session: PerfSession | undefined = activeSessionFor(ctx, deps.session, target.udid)
): Promise<Result<NativeRun, UiError>> {
	if (session !== undefined && session.capturers.some((c) => c.kind === "native" && c.state === "running")) {
		return {
			success: false,
			error: uiError("session_active", `session ${session.id} already has a native recording`, {
				hint: "warden perf native stop",
			}),
		};
	}
	if (session === undefined && findRunningOneShot(ctx, target.udid) !== undefined) {
		return {
			success: false,
			error: uiError("session_active", `a native recording is already running on ${target.udid}`, {
				hint: "warden perf native stop",
			}),
		};
	}
	const dir = session === undefined ? newOneShotDir(ctx, deps.session.random) : sessionNativeDir(ctx, session.id);
	const profiler = await profilers[target.platform]();
	const started = await profiler.start(ctx, deps, io, {
		target,
		app: opts.app,
		dir,
		leaks: opts.leaks,
		...(opts.flavor === undefined ? {} : { flavor: opts.flavor }),
		maxDurationMs: opts.maxDurationMs,
	});
	if (!started.success) return started;
	const file: HandleFile = {
		version: 1,
		status: "running",
		udid: target.udid,
		platform: target.platform,
		app: opts.app,
		leaks: opts.leaks,
		...(session === undefined ? {} : { sessionId: session.id }),
		handle: started.data,
	};
	writeHandleFile(dir, file);
	if (session !== undefined) {
		updateSession(ctx, session.id, (s) => ({
			...s,
			capturers: [
				...s.capturers.filter((c) => c.kind !== "native"),
				{
					kind: "native",
					...(started.data.pid === undefined ? {} : { pid: started.data.pid }),
					startedAtIso: started.data.startedAtIso,
					out: started.data.out,
					state: "running",
				},
			],
		}));
	}
	return ok({
		dir,
		...(session === undefined ? {} : { sessionId: session.id }),
		handle: started.data,
		app: opts.app,
		leaks: opts.leaks,
	});
}

/** The recording running on `udid`: the session (`sessionId`, else the device's active one) first, else a one-shot. `perf stop` names the session because a capped one no longer counts as active. */
export function findNativeRun(
	ctx: CommandContext,
	deps: PerfDeps,
	udid: string,
	sessionId?: string
): { dir: string; file: HandleFile } | undefined {
	const sessionKey = sessionId ?? activeSessionFor(ctx, deps.session, udid)?.id;
	if (sessionKey !== undefined) {
		const dir = sessionNativeDir(ctx, sessionKey);
		const file = readHandleFile(dir);
		if (file?.status === "running") return { dir, file };
	}
	return findRunningOneShot(ctx, udid);
}

export type StoppedNative = NativeStopped & { dir: string; sessionId?: string; app: string };

/** Stop the recording `findNativeRun` finds, export + analyze it, and mark it stopped. */
export async function stopNative(
	ctx: CommandContext,
	deps: PerfDeps,
	io: NativeIo,
	profilers: NativeProfilers,
	target: PerfTarget,
	opts: { analyze: boolean; yes?: boolean; sessionId?: string }
): Promise<Result<StoppedNative, UiError>> {
	const found = findNativeRun(ctx, deps, target.udid, opts.sessionId);
	if (found === undefined) {
		return {
			success: false,
			error: uiError("session_not_found", `no native recording is running on ${target.udid}`, {
				hint: "warden perf native start",
			}),
		};
	}
	const { dir, file } = found;
	const profiler = await profilers[file.platform]();
	const stopped = await profiler.stop(ctx, deps, io, {
		target,
		app: file.app,
		dir,
		handle: file.handle,
		analyze: opts.analyze,
		...(opts.yes === true ? { yes: true } : {}),
	});
	writeHandleFile(dir, { ...file, status: "stopped" });
	if (file.sessionId !== undefined) {
		updateSession(ctx, file.sessionId, (s) => ({
			...s,
			capturers: s.capturers.map((c) =>
				c.kind === "native" && c.state === "running" ? { ...c, state: stopped.success ? "stopped" : "failed" } : c
			),
		}));
	}
	if (!stopped.success) return stopped;
	return ok({
		...stopped.data,
		dir,
		...(file.sessionId === undefined ? {} : { sessionId: file.sessionId }),
		app: file.app,
	});
}

function nativeSuccess(
	ctx: CommandContext,
	target: PerfTarget,
	input: {
		app: string;
		dir: string;
		sessionId?: string;
		out: string;
		analysis?: NativeAnalysis;
		warnings: string[];
		/** write report.md / report.json beside the native dir (one-shot recordings only) */
		writeReport?: boolean;
	}
): UiSuccess {
	const { analysis } = input;
	const findings: Finding[] = analysis?.findings ?? [];
	const rel = displayPath(ctx, input.out);
	const next = [
		`open ${rel}   (Instruments)`,
		...(target.platform === "ios" ? ["warden perf native --leaks   (cold launch, leak check)"] : []),
		"warden perf native --duration 30s",
	];
	const text = renderMarkdown(
		{
			title: `Native profile (${target.platform})`,
			banners: [SIMULATOR_BANNER],
			summary: [
				`${input.app} on ${target.name ?? target.udid}`,
				`trace: ${rel}`,
				...(analysis?.summary ?? ["not analyzed: warden perf native --analyze <trace>"]),
			],
			findings,
			sections: analysis === undefined ? [] : [analysis.section],
			next,
		},
		{ maxLines: MAX_TEXT_LINES }
	);
	if (analysis !== undefined && input.sessionId === undefined && input.writeReport !== false) {
		const root = dirname(input.dir);
		const full = renderMarkdown({
			title: `Native profile (${target.platform})`,
			banners: [SIMULATOR_BANNER],
			summary: analysis.summary,
			findings,
			sections: [analysis.section],
			next,
		});
		writeFileSync(join(root, "report.md"), `${full}\n`);
		writeFileSync(
			join(root, "report.json"),
			`${JSON.stringify({ app: input.app, native: analysis.report, findings }, null, 2)}\n`
		);
	}
	return {
		device: { udid: target.udid, platform: target.platform, name: target.name },
		result: {
			...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
			app: input.app,
			dir: input.dir,
			trace: input.out,
			files: analysis?.files ?? { trace: input.out },
			native: analysis?.report ?? null,
			findings,
			next,
		},
		text,
		warnings: input.warnings,
	};
}

function planDuration(opts: PerfNativeOptions): Result<number, UiError> {
	if (opts.duration === undefined) return ok(DEFAULT_DURATION_MS);
	const ms = parseDuration(opts.duration);
	if (ms === undefined) {
		return {
			success: false,
			error: uiError("usage", `--duration must be a duration like 10s or 1m, got "${opts.duration}"`),
		};
	}
	return ok(Math.min(ms, HARD_MAX_DURATION_MS));
}

/** `--analyze <trace>`: re-analyze a recorded trace; no device needed. */
async function reanalyze(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfNativeOptions,
	profilers: NativeProfilers
): Promise<number> {
	const report = { command: "perf native", label: "perf native", json: opts.json === true, startedAt: ctx.now() };
	try {
		const trace = resolve(ctx.cwd, opts.analyze ?? "");
		const platform: Platform = trace.endsWith(".trace") ? "ios" : "android";
		const profiler = await profilers[platform]();
		const dir = dirname(trace);
		const target: PerfTarget = { udid: "-", platform, ownedByCaller: false, source: "flag", mode: "observe" };
		const analysis = await profiler.analyze(ctx, deps, {
			target,
			app: "",
			dir,
			trace,
			...(opts.yes === true ? { yes: true } : {}),
		});
		if (!analysis.success) return reportError(ctx, report, analysis.error);
		const success = nativeSuccess(ctx, target, {
			app: "(from trace)",
			dir,
			out: trace,
			analysis: analysis.data,
			warnings: analysis.data.warnings,
			writeReport: false,
		});
		return reportOk(ctx, report, { ...success, device: { udid: "-", platform } });
	} catch (error) {
		return reportError(ctx, report, uiError("failed", error instanceof Error ? error.message : String(error)));
	}
}

/**
 * `warden perf native [start|stop] [--duration 10s] [--leaks] [--analyze <trace>]`: native CPU, hangs and (iOS
 * `--leaks`) leaks from the platform's profiler: iOS `xctrace` Time Profiler + Hangs, Android perfetto / simpleperf.
 * `start` begins a detached recording and `stop` ends, exports and analyzes it; no action = start, wait `--duration`,
 * stop. Attach-only recording observes any warden device; `--leaks` cold-launches the app (MALLOC stack logging) and
 * needs the caller's lease.
 */
export function perfNative(
	ctx: CommandContext,
	deps: PerfDeps,
	action: string | undefined,
	opts: PerfNativeOptions,
	io: NativeIo = defaultNativeIo,
	profilers: NativeProfilers = defaultNativeProfilers
): Promise<number> {
	if (opts.analyze !== undefined) return reanalyze(ctx, deps, opts, profilers);
	const label = action === undefined ? "native" : `native ${action}`;
	const mode = action !== "stop" && opts.leaks === true ? "mutate" : "observe";
	return runPerf(ctx, deps, label, mode, opts, async (target) => {
		if (action !== undefined && action !== "start" && action !== "stop") {
			return { success: false, error: uiError("usage", `unknown native action "${action}"`, { hint: "start | stop" }) };
		}
		const analyze = opts.skipAnalysis !== true;
		if (action === "stop") {
			const stopped = await stopNative(ctx, deps, io, profilers, target, { analyze, yes: opts.yes });
			if (!stopped.success) return stopped;
			return ok(nativeSuccess(ctx, target, stopped.data));
		}
		const duration = planDuration(opts);
		if (!duration.success) return duration;
		const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		const session = activeSessionFor(ctx, deps.session, target.udid);
		const started = await startNative(
			ctx,
			deps,
			io,
			profilers,
			target,
			{
				app: app.data.id,
				leaks: opts.leaks === true,
				...(opts.flavor === undefined ? {} : { flavor: opts.flavor }),
				maxDurationMs:
					action === "start" ? (session?.maxDurationMs ?? HARD_MAX_DURATION_MS) : duration.data + LIMIT_SLACK_MS,
			},
			session
		);
		if (!started.success) return started;
		if (action === "start") {
			const rel = displayPath(ctx, started.data.handle.out);
			return ok({
				device: { udid: target.udid, platform: target.platform, name: target.name },
				result: {
					action: "start",
					state: "recording",
					app: app.data.id,
					dir: started.data.dir,
					trace: started.data.handle.out,
					...(started.data.sessionId === undefined ? {} : { sessionId: started.data.sessionId }),
					pid: started.data.handle.pid ?? null,
				},
				text: `recording ${app.data.id} to ${rel}\nnext:\n  warden perf native stop`,
				warnings: [],
			});
		}
		await io.sleep(duration.data);
		const stopped = await stopNative(ctx, deps, io, profilers, target, { analyze, yes: opts.yes });
		if (!stopped.success) return stopped;
		return ok(nativeSuccess(ctx, target, stopped.data));
	});
}

/** Wire `native` onto `warden perf`. */
export function registerNative(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: PerfDeps
): void {
	withPerfOptions(
		cmd
			.command("native")
			.description(
				"native CPU, hangs and leaks: iOS xctrace (Time Profiler + Hangs), Android perfetto / simpleperf; start | stop, or one-shot"
			)
			.argument("[action]", "start | stop (default: record --duration, then stop)")
			.option("--duration <time>", "one-shot recording length (default 10s, max 5m)")
			.option("--analyze <trace>", "re-analyze a recorded trace instead of recording")
			.option("--leaks", "iOS: cold-launch the app with malloc stack logging and report leaks (needs the device lease)")
			.option("--skip-analysis", "stop: leave the trace unexported")
			.option("--flavor <name>", "Android: perfetto | simpleperf")
			.option("--yes", "Android: download trace_processor without asking")
	).action(async (action, opts) => {
		done(await perfNative(ctx, deps, action, opts));
	});
}
