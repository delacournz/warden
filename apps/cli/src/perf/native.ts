import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command as Commander } from "@commander-js/extra-typings";
import { parseDuration } from "@delacour/warden-perf/metrics/duration";
import { HARD_MAX_DURATION_MS, MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import { renderMarkdown, SIMULATOR_BANNER } from "@delacour/warden-perf/shared/render-md";
import {
	defaultNativeProfilers,
	type NativeProfilers,
	type NativeRun,
	type StartNativeOptions,
	startNative,
	stopNative,
} from "@delacour/warden-sdk/ops/perf/native";
import { defaultNativeIo, type NativeAnalysis, type NativeIo } from "@delacour/warden-sdk/ops/perf/native-types";
import { displayPath } from "@delacour/warden-sdk/ops/perf/paths";
import { activeSessionFor } from "@delacour/warden-sdk/ops/perf/session";
import type { Platform } from "@delacour/warden-store/types";
import { ok, type Result } from "@delacour/warden-types/result";
import { reportError, reportOk, type UiError, type UiSuccess, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import type { PerfTarget } from "./device";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";

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

/** `stop`: end the running recording, then shape the success report. */
async function stopAndReport(
	ctx: CommandContext,
	deps: PerfDeps,
	io: NativeIo,
	profilers: NativeProfilers,
	target: PerfTarget,
	analyze: boolean,
	yes: boolean | undefined
): Promise<Result<UiSuccess, UiError>> {
	const stopped = await stopNative(ctx, deps, io, profilers, target, { analyze, yes });
	if (!stopped.success) return stopped;
	return ok(nativeSuccess(ctx, target, stopped.data));
}

/** `start`: the detached recording's report, with the follow-up `stop` hint. */
function startedReport(ctx: CommandContext, target: PerfTarget, app: string, run: NativeRun): UiSuccess {
	const rel = displayPath(ctx, run.handle.out);
	return {
		device: { udid: target.udid, platform: target.platform, name: target.name },
		result: {
			action: "start",
			state: "recording",
			app,
			dir: run.dir,
			trace: run.handle.out,
			...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
			pid: run.handle.pid ?? null,
		},
		text: `recording ${app} to ${rel}\nnext:\n  warden perf native stop`,
		warnings: [],
	};
}

/** True for no action or a known one (`start` | `stop`). */
function isNativeAction(action: string | undefined): action is "start" | "stop" | undefined {
	return action === undefined || action === "start" || action === "stop";
}

/** The `startNative` options a `perf native` call carries, minus the duration cap. */
function startOptions(opts: PerfNativeOptions, app: string): Omit<StartNativeOptions, "maxDurationMs"> {
	return { app, leaks: opts.leaks === true, ...(opts.flavor === undefined ? {} : { flavor: opts.flavor }) };
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
		if (!isNativeAction(action)) {
			return { success: false, error: uiError("usage", `unknown native action "${action}"`, { hint: "start | stop" }) };
		}
		const analyze = opts.skipAnalysis !== true;
		if (action === "stop") return stopAndReport(ctx, deps, io, profilers, target, analyze, opts.yes);
		const duration = planDuration(opts);
		if (!duration.success) return duration;
		const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		const session = activeSessionFor(ctx, deps.session, target.udid);
		const maxDurationMs =
			action === "start" ? (session?.maxDurationMs ?? HARD_MAX_DURATION_MS) : duration.data + LIMIT_SLACK_MS;
		const started = await startNative(
			ctx,
			deps,
			io,
			profilers,
			target,
			{ ...startOptions(opts, app.data.id), maxDurationMs },
			session
		);
		if (!started.success) return started;
		if (action === "start") return ok(startedReport(ctx, target, app.data.id, started.data));
		await io.sleep(duration.data);
		return stopAndReport(ctx, deps, io, profilers, target, analyze, opts.yes);
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
