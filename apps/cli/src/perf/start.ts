import type { Command as Commander, OptionValues } from "@commander-js/extra-typings";
import { formatDuration } from "@delacour/warden-core/duration";
import { ok } from "@delacour/warden-types/result";
import { type UiSuccess, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import type { PerfTarget } from "./device";
import { withPerfOptions } from "./options";
import { defaultSessionKit, type SessionKit, type StartOptions, type StartOutcome, startPerf } from "./orchestrate";
import { sessionDir } from "./paths";
import { type PerfDeps, runPerf } from "./run";
import { activeSessionFor } from "./session";

export type PerfStartOptions = StartOptions & { join?: boolean };

const offset = (ms: number): string => `+${(ms / 1000).toFixed(1)}s`;

function infoOf(target: PerfTarget) {
	return { udid: target.udid, platform: target.platform, name: target.name };
}

/** What `start` and `record` print once the session runs: the armed and failed captures, the launch, how to stop. */
export function startedSuccess(
	ctx: CommandContext,
	target: PerfTarget,
	out: StartOutcome,
	stopHint: string
): UiSuccess {
	const { session, plan } = out;
	const armed = session.capturers.filter((c) => c.kind !== "collector" && c.state === "running").map((c) => c.kind);
	const failed = session.capturers.filter((c) => c.kind !== "collector" && c.state === "failed").map((c) => c.kind);
	const lines = [
		`${ctx.ui.color.green("started")} ${session.id} on ${target.name ?? target.udid} (${session.app?.id ?? plan.app})`,
		`armed: ${armed.join(", ") || "none yet"}${failed.length > 0 ? `   failed: ${failed.join(", ")}` : ""}`,
		`stops itself after ${formatDuration(session.maxDurationMs)}`,
	];
	if (out.launch?.kind === "launched")
		lines.push(`relaunched: ${out.launch.am?.totalMs ?? out.launch.wallMs}ms to start`);
	const next = ['warden perf mark "<what you are about to do>"', stopHint];
	lines.push("next:", ...next.map((n) => `  ${n}`));
	return {
		device: infoOf(target),
		result: {
			sessionId: session.id,
			dir: sessionDir(ctx, session.id),
			app: session.app?.id ?? plan.app,
			maxDurationMs: session.maxDurationMs,
			capturers: session.capturers.map((c) => ({
				kind: c.kind,
				state: c.state,
				...(c.out === undefined ? {} : { out: c.out }),
			})),
			plan,
			...(out.launch === undefined ? {} : { launch: out.launch }),
			...(out.leaseId === undefined ? {} : { leaseId: out.leaseId }),
			next,
		},
		text: lines.join("\n"),
		...(out.warnings.length > 0 ? { warnings: out.warnings } : {}),
	};
}

/**
 * `warden perf start [--js] [--react] [--native[=perfetto|simpleperf]] [--metrics] [--frames] [--logs] [--all]
 * [--relaunch] [--reset] [--max-duration 30s] [--join]`: open a perf session on the device and arm its captures.
 * Observe-only unless `--relaunch` / `--reset` (they restart the app: your lease, or a free device).
 */
export function perfStart(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfStartOptions,
	kit: SessionKit = defaultSessionKit
): Promise<number> {
	return runPerf(ctx, deps, "start", "observe", opts, async (target) => {
		if (opts.join === true) {
			const live = activeSessionFor(ctx, deps.session, target.udid);
			if (live === undefined) {
				return {
					success: false,
					error: uiError("session_not_found", `no active perf session on ${target.udid} to join`, {
						hint: "warden perf start",
					}),
				};
			}
			const marks = live.marks.map((m) => `'${m.label}' ${offset(m.atMs)}`);
			return ok({
				device: infoOf(target),
				result: {
					sessionId: live.id,
					joined: true,
					app: live.app?.id ?? null,
					capturers: live.capturers.map((c) => ({ kind: c.kind, state: c.state })),
					marks: live.marks,
				},
				text: [
					`joined ${live.id} (read-only): ${
						live.capturers
							.filter((c) => c.kind !== "collector")
							.map((c) => `${c.kind}:${c.state}`)
							.join(", ") || "no captures yet"
					}`,
					marks.length > 0 ? `marks: ${marks.join(", ")}` : "no marks yet",
					'next:\n  warden perf mark "<label>"\n  warden perf stop',
				].join("\n"),
			});
		}
		const started = await startPerf(ctx, deps, kit, target, opts);
		if (!started.success) return started;
		return ok(startedSuccess(ctx, target, started.data, "warden perf stop"));
	});
}

/** The capture flags `start` and `record` share. */
export function withCaptureOptions<Args extends unknown[], Opts extends OptionValues, Globals extends OptionValues>(
	cmd: Commander<Args, Opts, Globals>
) {
	return withPerfOptions(cmd)
		.option("--js", "Hermes JS CPU profile, source-mapped (needs Metro)")
		.option("--react", "React render profile (needs a dev client)")
		.option("--native [flavor]", "native CPU + hangs: iOS xctrace, Android perfetto (or =simpleperf)")
		.option("--metrics", "CPU and memory every second")
		.option("--frames", "fps and jank (Android)")
		.option("--logs", "the app's device logs, redacted")
		.option("--all", "every capture above")
		.option("--relaunch", "stop the app, arm the captures, launch it: startup and early JS/React are recorded")
		.option("--reset", "like --relaunch, but wipe the app's data first (same build)")
		.option("--max-duration <time>", "hard cap on the session (default 30s, max 5m)")
		.option("--yes", "download tools the analysis needs (trace_processor) without asking");
}

/** Wire `start` onto `warden perf`. */
export function registerStart(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	withCaptureOptions(
		cmd.command("start").description("open a perf session: arm metrics, logs, frames, JS, React and native captures")
	)
		.option("--join", "attach read-only to the device's running session (id, marks) instead of starting one")
		.action(async (opts) => {
			done(await perfStart(ctx, deps, opts));
		});
}
