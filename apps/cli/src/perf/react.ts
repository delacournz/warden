import type { Command as Commander } from "@commander-js/extra-typings";
import { formatDuration } from "@delacour/warden-core/duration";
import { parseDuration } from "@delacour/warden-perf/metrics/duration";
import { HARD_MAX_DURATION_MS, MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import { DEV_BUILD_BANNER, renderMarkdown, SIMULATOR_BANNER } from "@delacour/warden-perf/shared/render-md";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, type UiSuccess, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import type { PerfTarget } from "./device";
import { connectJs } from "./js";
import { defaultJsDeps, type JsDeps } from "./js-capture";
import { withPerfOptions } from "./options";
import { displayPath } from "./paths";
import {
	type ReactCaptureResult,
	reactOwner,
	reactUiError,
	runReactCapture,
	startReactCapture,
	stopReactCapture,
} from "./react-capture";
import { type ReactOut, reactOutFor } from "./react-out";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";

export type PerfReactOptions = PerfOptionValues & { duration?: string; metro?: string; takeOver?: boolean };

const DEFAULT_DURATION_MS = 10_000;

function planDuration(opts: PerfReactOptions): Result<number, UiError> {
	if (opts.duration === undefined) return ok(DEFAULT_DURATION_MS);
	const duration = parseDuration(opts.duration);
	if (duration === undefined) {
		return {
			success: false,
			error: uiError("usage", `--duration must be a duration like 10s or 1m, got "${opts.duration}"`),
		};
	}
	return ok(Math.min(duration, HARD_MAX_DURATION_MS));
}

function stoppedSuccess(
	ctx: CommandContext,
	target: PerfTarget,
	app: string,
	out: ReactOut,
	result: ReactCaptureResult
): UiSuccess {
	const { analysis } = result;
	const t = analysis.totals;
	const hasCpu = analysis.hotCommits.some((h) => h.cpu.length > 0);
	const next = [
		"warden perf react start   (then interact with the app)  /  warden perf react stop",
		...(analysis.hotCommits.length > 0 && !hasCpu
			? ["warden perf record --js --react --duration 10s   (adds the JS functions inside each hot commit)"]
			: []),
		`full report: ${displayPath(ctx, result.findingsPath)}`,
	];
	const text = renderMarkdown(
		{
			title: "React renders",
			banners: [SIMULATOR_BANNER, ...(analysis.dev === true ? [DEV_BUILD_BANNER] : [])],
			summary: [
				`${app} on ${target.name ?? target.udid} (${target.platform}): ${t.commits} commits, ${Math.round(t.renderMs)}ms rendering, ${t.hot} hot, ${t.warm} warm`,
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
			files: { commits: result.commitsPath, findings: result.findingsPath },
			totals: t,
			hotCommits: analysis.hotCommits.slice(0, 10),
			components: analysis.components.slice(0, 10),
			findings: result.findings,
			next,
		},
		text,
		warnings: analysis.warnings,
	};
}

/**
 * `warden perf react [--duration 10s]`: record React renders in the running dev client for a while, then rank the
 * hot commits, the costly components and findings (`slow-commit`, `memo-defeated`, `context-cascade` …). Observe-only.
 * Writes `react/commits.json` and `react/findings.json` into the running session, else a one-shot dir under
 * `$WARDEN_HOME/perf`. The profile is held by the app's runtime, so a dropped connection loses nothing.
 */
export function perfReact(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfReactOptions,
	js: JsDeps = defaultJsDeps
): Promise<number> {
	return runPerf(ctx, deps, "react", "observe", opts, async (target, env) => {
		const duration = planDuration(opts);
		if (!duration.success) return duration;
		const out = reactOutFor(ctx, deps.session, target.udid);
		const connected = await connectJs(ctx, deps, js, target, opts, env.timeoutMs);
		if (!connected.success) return connected;
		const { session, app } = connected.data;
		try {
			const captured = await runReactCapture(session, {
				dir: out.dir,
				...(out.jsDir === undefined ? {} : { jsDir: out.jsDir }),
				cwd: ctx.cwd,
				...(out.sessionId === undefined ? {} : { sessionId: out.sessionId }),
				owner: await reactOwner(ctx),
				force: opts.takeOver === true,
				durationMs: duration.data,
				sleep: js.sleep,
				now: ctx.now,
			});
			if (!captured.success) return { success: false, error: reactUiError(captured.error) };
			return ok(stoppedSuccess(ctx, target, app, out, captured.data));
		} finally {
			session.close();
		}
	});
}

/** `warden perf react start`: begin recording and return; stop it later with `warden perf react stop`. */
export function perfReactStart(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfReactOptions,
	js: JsDeps = defaultJsDeps
): Promise<number> {
	return runPerf(ctx, deps, "react start", "observe", opts, async (target, env) => {
		const connected = await connectJs(ctx, deps, js, target, opts, env.timeoutMs);
		if (!connected.success) return connected;
		const { session, app } = connected.data;
		try {
			const started = await startReactCapture(session, { owner: await reactOwner(ctx), force: opts.takeOver === true });
			if (!started.success) return { success: false, error: reactUiError(started.error) };
			const next = ["warden perf react stop   (after the interaction; max 5m before the marker goes stale)"];
			const s = started.data;
			return ok({
				device: { udid: target.udid, platform: target.platform, name: target.name },
				result: { app, startedWallMs: s.startedWallMs, rn: s.rn, dev: s.dev, bootstrapped: s.bootstrapped, next },
				text: [
					`React profiling started in ${app}${s.rn === null ? "" : ` (React Native ${s.rn})`}${s.bootstrapped ? ", DevTools backend attached" : ""}`,
					"next:",
					...next.map((n) => `  ${n}`),
				].join("\n"),
			});
		} finally {
			session.close();
		}
	});
}

/** `warden perf react stop`: end the recording, then analyse and write like the one-shot. */
export function perfReactStop(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfReactOptions,
	js: JsDeps = defaultJsDeps
): Promise<number> {
	return runPerf(ctx, deps, "react stop", "observe", opts, async (target, env) => {
		const out = reactOutFor(ctx, deps.session, target.udid);
		const connected = await connectJs(ctx, deps, js, target, opts, env.timeoutMs);
		if (!connected.success) return connected;
		const { session, app } = connected.data;
		try {
			const stopped = await stopReactCapture(session, {
				dir: out.dir,
				...(out.jsDir === undefined ? {} : { jsDir: out.jsDir }),
				cwd: ctx.cwd,
				...(out.sessionId === undefined ? {} : { sessionId: out.sessionId }),
				owner: await reactOwner(ctx),
				force: opts.takeOver === true,
			});
			if (!stopped.success) return { success: false, error: reactUiError(stopped.error) };
			return ok(stoppedSuccess(ctx, target, app, out, stopped.data));
		} finally {
			session.close();
		}
	});
}

/** Wire `react` (with `start` / `stop`) onto `warden perf`. */
export function registerReact(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	const react = withPerfOptions(
		cmd
			.command("react")
			.description("React render profile of the dev client: hot commits, costly components, ranked findings")
			.option("--duration <time>", `how long to record (default ${formatDuration(DEFAULT_DURATION_MS)}, max 5m)`)
			.option("--metro <url>", "Metro to attach through (default: the one serving the device)")
			.option("--take-over", "take over a React profile another agent started")
	);
	react.action(async (opts) => {
		done(await perfReact(ctx, deps, opts));
	});
	withPerfOptions(
		react
			.command("start")
			.description("start recording React renders and return (stop with `perf react stop`)")
			.option("--metro <url>", "Metro to attach through (default: the one serving the device)")
			.option("--take-over", "take over a React profile another agent started")
	).action(async (opts) => {
		done(await perfReactStart(ctx, deps, opts));
	});
	withPerfOptions(
		react
			.command("stop")
			.description("stop the recording, then rank hot commits, components and findings")
			.option("--metro <url>", "Metro to attach through (default: the one serving the device)")
			.option("--take-over", "stop a React profile another agent started")
	).action(async (opts) => {
		done(await perfReactStop(ctx, deps, opts));
	});
}
