import { durationParser } from "@delacour/warden-config/duration";
import { DEFAULT_SAMPLING_INTERVAL_US } from "@delacour/warden-perf/js/cpu-profile";
import { perfDuration } from "@delacour/warden-perf/metrics/duration";
import { HARD_MAX_DURATION_MS, MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import type { Finding } from "@delacour/warden-perf/shared/findings.types";
import { DEV_BUILD_BANNER, markdownRenderer, SIMULATOR_BANNER } from "@delacour/warden-perf/shared/render-md";
import type { WardenError } from "@delacour/warden-types/error";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { opError } from "../errors";
import type { PerfEnv } from "./env";
import {
	devtoolsPerfError,
	type JsDeps,
	type JsProfileResult,
	type JsSession,
	jsUiError,
	runJsCapture,
} from "./js-capture";
import { type JsOut, jsOutFor } from "./js-out";
import { displayPath } from "./paths";
import type { PerfDone, PerfEngineDeps, PerfOutcome, PerfTarget } from "./types";

/** What a `js` profile takes: a `duration` like `10s` and the sampling period in microseconds. */
export type JsParams = { duration?: string; samplingInterval?: string };

const DEFAULT_DURATION_MS = 10_000;

export type JsPlan = { durationMs: number; samplingIntervalUs: number };

export function planJs(opts: JsParams): Result<JsPlan, WardenError> {
	const duration = opts.duration === undefined ? DEFAULT_DURATION_MS : perfDuration.parseDuration(opts.duration);
	if (duration === undefined || duration < 1) {
		return {
			success: false,
			error: opError("usage", `--duration must be a duration like 10s or 1m, got "${opts.duration}"`),
		};
	}
	const interval = opts.samplingInterval === undefined ? DEFAULT_SAMPLING_INTERVAL_US : Number(opts.samplingInterval);
	if (!Number.isInteger(interval) || interval < 10) {
		return {
			success: false,
			error: opError("usage", `--sampling-interval is microseconds, at least 10, got "${opts.samplingInterval}"`),
		};
	}
	return resultFactory.ok({ durationMs: Math.min(duration, HARD_MAX_DURATION_MS), samplingIntervalUs: interval });
}

/** `--metro`, else the Metro serving this device. */
export async function metroFor(
	ctx: PerfEnv,
	deps: PerfEngineDeps,
	target: PerfTarget,
	flag: string | undefined
): Promise<Result<string, WardenError>> {
	const url = flag !== undefined && flag !== "" ? flag.replace(/\/+$/, "") : await deps.host.metro(ctx, target.udid);
	if (url !== undefined) return resultFactory.ok(url);
	return {
		success: false,
		error: opError(
			"devtools_unavailable",
			"no Metro found for this device: a release build, or no dev client running",
			{
				hint: "start the dev client with `warden dev <platform>`, or pass --metro <url>",
			}
		),
	};
}

export function jsSuccess(
	ctx: PerfEnv,
	target: PerfTarget,
	app: string,
	out: JsOut,
	result: JsProfileResult,
	durationMs: number
): PerfDone<JsResult> {
	const h = result.hotspots;
	const next = [
		`warden perf js --duration ${durationParser.format(durationMs * 3)}`,
		"warden perf mark <label>   (then compare hotspots across runs)",
	];
	const text = markdownRenderer.renderMarkdown(
		{
			title: "JS CPU profile",
			banners: [SIMULATOR_BANNER, ...(h.dev === true ? [DEV_BUILD_BANNER] : [])],
			summary: [
				`${app} on ${target.name ?? target.udid} (${target.platform}): ${h.sampleCount} samples over ${(h.durationMs / 1000).toFixed(1)}s, ${h.idlePct}% idle`,
				`profile: ${displayPath(ctx, result.cpuPath)} (open in Chrome DevTools or speedscope)`,
			],
			findings: result.findings,
			sections: [result.section],
			next,
		},
		{ maxLines: MAX_TEXT_LINES }
	);
	return {
		device: { udid: target.udid, platform: target.platform, name: target.name },
		result: {
			...(out.sessionId === undefined ? {} : { sessionId: out.sessionId }),
			app,
			dir: out.dir,
			files: { cpuprofile: result.cpuPath, hotspots: result.hotspotsPath },
			hotspots: h,
			findings: result.findings,
			next,
		},
		text,
		warnings: h.warnings,
	};
}

/** The `result` of `perf js --json`. */
export type JsResult = {
	sessionId?: string;
	app: string;
	dir: string;
	files: { cpuprofile: string; hotspots: string };
	hotspots: JsProfileResult["hotspots"];
	findings: Finding[];
	next: string[];
};

/** App, Metro and the Hermes socket for an already known app; the caller closes `session`. */
export async function connectJsApp(
	ctx: PerfEnv,
	deps: PerfEngineDeps,
	js: JsDeps,
	target: PerfTarget,
	app: string,
	metroFlag: string | undefined,
	timeoutMs: number
): Promise<Result<{ session: JsSession; metro: string; app: string }, WardenError>> {
	const metro = await metroFor(ctx, deps, target, metroFlag);
	if (!metro.success) return metro;
	const session = await js.open({
		metroUrl: metro.data,
		appId: app,
		deviceName: target.platform === "ios" ? target.name : undefined,
		timeoutMs,
	});
	if (!session.success) return { success: false, error: devtoolsPerfError(session.error) };
	return resultFactory.ok({ session: session.data, metro: metro.data, app });
}

/**
 * A Hermes JS CPU profile of the running dev client on a resolved device and app, source-mapped to hotspots.
 * Observe-only. Writes `js/cpu.cpuprofile` and `js/hotspots.json` into the running session, else a one-shot dir.
 */
export async function jsWork(
	ctx: PerfEnv,
	deps: PerfEngineDeps,
	js: JsDeps,
	target: PerfTarget,
	app: string,
	planned: JsPlan,
	metro: string | undefined,
	timeoutMs: number
): PerfOutcome<JsResult> {
	const out = jsOutFor(ctx, deps.session, target.udid, "js");
	if (out.jsCapturing) {
		return {
			success: false,
			error: opError("session_active", `session ${out.sessionId} already holds the JS profiler on ${target.udid}`, {
				hint: "its profile lands in js/cpu.cpuprofile when it stops (warden perf stop)",
			}),
		};
	}
	const connected = await connectJsApp(ctx, deps, js, target, app, metro, timeoutMs);
	if (!connected.success) return connected;
	const { session, metro: metroUrl } = connected.data;
	try {
		const captured = await runJsCapture(session, {
			dir: out.dir,
			metroUrl,
			fetchMap: js.fetchMap,
			projectRoot: ctx.cwd,
			durationMs: planned.durationMs,
			samplingIntervalUs: planned.samplingIntervalUs,
			sleep: js.sleep,
			now: ctx.now,
		});
		if (!captured.success) return { success: false, error: jsUiError(captured.error) };
		return resultFactory.ok(jsSuccess(ctx, target, app, out, captured.data, planned.durationMs));
	} finally {
		session.close();
	}
}
