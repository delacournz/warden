import { readFileSync } from "node:fs";
import type { Command as Commander } from "@commander-js/extra-typings";
import { formatDuration } from "@delacour/warden-core/duration";
import { DEFAULT_SAMPLING_INTERVAL_US } from "@delacour/warden-perf/js/cpu-profile";
import { type Hotspots, hotspotFindings, hotspotsSection } from "@delacour/warden-perf/js/hotspots";
import { parseDuration } from "@delacour/warden-perf/metrics/duration";
import { HARD_MAX_DURATION_MS, MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import { DEV_BUILD_BANNER, renderMarkdown, SIMULATOR_BANNER } from "@delacour/warden-perf/shared/render-md";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, type UiSuccess, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import { resumeBrokerOnClose } from "./broker-resume";
import type { PerfTarget } from "./device";
import {
	defaultJsDeps,
	devtoolsPerfError,
	type JsDeps,
	type JsProfileResult,
	type JsSession,
	jsUiError,
	runJsCapture,
} from "./js-capture";
import { type JsOut, jsOutFor } from "./js-out";
import { withPerfOptions } from "./options";
import { displayPath } from "./paths";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";

export type PerfJsOptions = PerfOptionValues & { duration?: string; samplingInterval?: string; metro?: string };

const DEFAULT_DURATION_MS = 10_000;

type Plan = { durationMs: number; samplingIntervalUs: number };

function plan(opts: PerfJsOptions): Result<Plan, UiError> {
	const duration = opts.duration === undefined ? DEFAULT_DURATION_MS : parseDuration(opts.duration);
	if (duration === undefined || duration < 1) {
		return {
			success: false,
			error: uiError("usage", `--duration must be a duration like 10s or 1m, got "${opts.duration}"`),
		};
	}
	const interval = opts.samplingInterval === undefined ? DEFAULT_SAMPLING_INTERVAL_US : Number(opts.samplingInterval);
	if (!Number.isInteger(interval) || interval < 10) {
		return {
			success: false,
			error: uiError("usage", `--sampling-interval is microseconds, at least 10, got "${opts.samplingInterval}"`),
		};
	}
	return ok({ durationMs: Math.min(duration, HARD_MAX_DURATION_MS), samplingIntervalUs: interval });
}

/** `--metro`, else the Metro serving this device. */
export async function metroFor(
	ctx: CommandContext,
	deps: PerfDeps,
	target: PerfTarget,
	flag: string | undefined
): Promise<Result<string, UiError>> {
	const url = flag !== undefined && flag !== "" ? flag.replace(/\/+$/, "") : await deps.host.metro(ctx, target.udid);
	if (url !== undefined) return ok(url);
	return {
		success: false,
		error: uiError(
			"devtools_unavailable",
			"no Metro found for this device: a release build, or no dev client running",
			{
				hint: "start the dev client with `warden dev <platform>`, or pass --metro <url>",
			}
		),
	};
}

type Connected = { session: JsSession; metro: string; app: string };

/** App, Metro and the Hermes socket for a device; the caller closes `session`. */
export async function connectJs(
	ctx: CommandContext,
	deps: PerfDeps,
	js: JsDeps,
	target: PerfTarget,
	opts: { app?: string; metro?: string },
	timeoutMs: number
): Promise<Result<Connected, UiError>> {
	const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
	if (!app.success) return app;
	const metro = await metroFor(ctx, deps, target, opts.metro);
	if (!metro.success) return metro;
	const session = await js.open({
		metroUrl: metro.data,
		appId: app.data.id,
		deviceName: target.platform === "ios" ? target.name : undefined,
		timeoutMs,
	});
	if (!session.success) return { success: false, error: devtoolsPerfError(session.error) };
	return ok({ session: resumeBrokerOnClose(ctx, target.udid, session.data), metro: metro.data, app: app.data.id });
}

function successOf(
	ctx: CommandContext,
	target: PerfTarget,
	app: string,
	out: JsOut,
	result: JsProfileResult,
	durationMs: number
): UiSuccess {
	const h = result.hotspots;
	const next = [
		`warden perf js --duration ${formatDuration(durationMs * 3)}`,
		"warden perf mark <label>   (then compare hotspots across runs)",
	];
	const text = renderMarkdown(
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

/**
 * The profile taken on the dev session's broker socket (`profile.start` / `profile.stop`) when `warden dev` serves
 * the device: no second Hermes socket, so a single-debugger Metro never evicts the broker. `undefined` = no broker,
 * use the direct path. Artifacts stay in the session's `profiles/` dir, not the perf session's `js/`.
 */
async function brokeredProfile(
	ctx: CommandContext,
	target: PerfTarget,
	opts: PerfJsOptions,
	plan: Plan,
	out: JsOut,
	sleep: JsDeps["sleep"]
): Promise<Result<UiSuccess, UiError> | undefined> {
	const { udid } = target;
	const client = await import("../dev-broker/profile-client");
	if (!client.brokerSocketFor(ctx.env, { udid }).success) return undefined;
	const started = await client.startProfile(ctx.env, {
		udid,
		kind: "cpu",
		samplingIntervalUs: plan.samplingIntervalUs,
	});
	if (!started.success) {
		return {
			success: false,
			error: uiError("failed", started.error.message, started.error.hint ? { hint: started.error.hint } : {}),
		};
	}
	await sleep(plan.durationMs);
	const stopped = await client.stopProfile(ctx.env, { udid, kind: "cpu" });
	if (!stopped.success) {
		return {
			success: false,
			error: uiError("failed", stopped.error.message, stopped.error.hint ? { hint: stopped.error.hint } : {}),
		};
	}
	const summary = stopped.data.summary;
	if (summary.kind !== "cpu") return { success: false, error: uiError("failed", "broker returned a non-CPU profile") };
	try {
		const hotspots: Hotspots = JSON.parse(readFileSync(summary.hotspotsPath, "utf8"));
		const result: JsProfileResult = {
			cpuPath: stopped.data.path,
			hotspotsPath: summary.hotspotsPath,
			hotspots,
			findings: hotspotFindings(hotspots),
			section: hotspotsSection(hotspots),
		};
		const app = await resolveApp(ctx, { platform: target.platform, id: udid }, opts.app);
		return ok(successOf(ctx, target, app.success ? app.data.id : "app", out, result, plan.durationMs));
	} catch (error) {
		return { success: false, error: uiError("failed", `cannot read ${summary.hotspotsPath}: ${String(error)}`) };
	}
}

function capturingError(out: JsOut, udid: string): UiError {
	return uiError("session_active", `session ${out.sessionId} already holds the JS profiler on ${udid}`, {
		hint: "its profile lands in js/cpu.cpuprofile when it stops (warden perf stop)",
	});
}

type DirectProfile = {
	ctx: CommandContext;
	deps: PerfDeps;
	js: JsDeps;
	target: PerfTarget;
	opts: PerfJsOptions;
	plan: Plan;
	out: JsOut;
	timeoutMs: number;
};

/** The profile over this process's own Hermes socket (no dev-session broker for the device). */
async function directProfile(d: DirectProfile): Promise<Result<UiSuccess, UiError>> {
	const connected = await connectJs(d.ctx, d.deps, d.js, d.target, d.opts, d.timeoutMs);
	if (!connected.success) return connected;
	const { session, metro, app } = connected.data;
	try {
		const captured = await runJsCapture(session, {
			dir: d.out.dir,
			metroUrl: metro,
			fetchMap: d.js.fetchMap,
			projectRoot: d.ctx.cwd,
			durationMs: d.plan.durationMs,
			samplingIntervalUs: d.plan.samplingIntervalUs,
			sleep: d.js.sleep,
			now: d.ctx.now,
		});
		if (!captured.success) return { success: false, error: jsUiError(captured.error) };
		return ok(successOf(d.ctx, d.target, app, d.out, captured.data, d.plan.durationMs));
	} finally {
		session.close();
	}
}

/**
 * `warden perf js [--duration 10s] [--sampling-interval 100]`: a Hermes JS CPU profile of the running dev client,
 * source-mapped to `file:line` hotspots. Observe-only. Writes `js/cpu.cpuprofile` and `js/hotspots.json` into the
 * running session, else a one-shot dir under `$WARDEN_HOME/perf`. The profile is held by this process's socket for
 * the whole capture; a JS reload during it loses the profile.
 */
export function perfJs(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfJsOptions,
	js: JsDeps = defaultJsDeps
): Promise<number> {
	return runPerf(ctx, deps, "js", "observe", opts, async (target, env) => {
		const planned = plan(opts);
		if (!planned.success) return planned;
		const out = jsOutFor(ctx, deps.session, target.udid, "js");
		if (out.jsCapturing) return { success: false, error: capturingError(out, target.udid) };
		const brokered = await brokeredProfile(ctx, target, opts, planned.data, out, js.sleep);
		if (brokered !== undefined) return brokered;
		return directProfile({ ctx, deps, js, target, opts, plan: planned.data, out, timeoutMs: env.timeoutMs });
	});
}

/** Wire `js` onto `warden perf`. */
export function registerJs(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	withPerfOptions(
		cmd
			.command("js")
			.description("Hermes JS CPU profile of the dev client, source-mapped to file:line hotspots (js/cpu.cpuprofile)")
			.option("--duration <time>", "how long to sample (default 10s, max 5m)")
			.option("--sampling-interval <us>", "sampling period in microseconds (default 100)")
			.option("--metro <url>", "Metro to attach through (default: the one serving the device)")
	).action(async (opts) => {
		done(await perfJs(ctx, deps, opts));
	});
}
