import type { Command as Commander } from "@commander-js/extra-typings";
import { MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import { renderReportMarkdown } from "@delacour/warden-perf/shared/report";
import { ok } from "@delacour/warden-types/result";
import { type UiSuccess, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import type { PerfTarget } from "./device";
import { withPerfOptions } from "./options";
import { defaultSessionKit, finalizeSession, type SessionKit, type StopOutcome } from "./orchestrate";
import { sessionDir } from "./paths";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";
import { runningSessionFor } from "./session";

export type PerfStopOptions = PerfOptionValues & { analyze?: boolean; yes?: boolean };

/** What `stop` and `record` print: the capped report with `next:` hints, or just where it went with `--no-analyze`. */
export function stoppedSuccess(ctx: CommandContext, target: PerfTarget, out: StopOutcome): UiSuccess {
	const { session, report } = out;
	const info = { udid: target.udid, platform: target.platform, name: target.name };
	const result = {
		sessionId: session.id,
		status: session.status,
		stopReason: session.stopReason ?? null,
		dir: sessionDir(ctx, session.id),
		...(out.reportPath === undefined ? {} : { reportPath: out.reportPath }),
		report: report ?? null,
	};
	const text =
		report === undefined
			? `stopped ${session.id}\nnext:\n  warden perf report ${session.id}`
			: renderReportMarkdown(report, { maxLines: MAX_TEXT_LINES });
	return { device: info, result, text, ...(out.warnings.length > 0 ? { warnings: out.warnings } : {}) };
}

/**
 * `warden perf stop [--no-analyze] [--yes]`: end the device's session. Stops the captures in reverse order (the
 * collector flushes JS, React, metrics and logs; then the native recorder; then frames and crashes), gives back a
 * lease `start` took, and writes `report.md` + `report.json` (unless `--no-analyze`).
 */
export function perfStop(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfStopOptions,
	kit: SessionKit = defaultSessionKit
): Promise<number> {
	return runPerf(ctx, deps, "stop", "observe", opts, async (target) => {
		const session = runningSessionFor(ctx, target.udid);
		if (session === undefined) {
			return {
				success: false,
				error: uiError("session_not_found", `no running perf session on ${target.udid}`, {
					hint: "warden perf start (warden perf ls lists finished ones)",
				}),
			};
		}
		const stopped = await finalizeSession(ctx, deps, kit, session.id, {
			reason: "user",
			analyze: opts.analyze !== false,
			...(opts.yes === true ? { yes: true } : {}),
		});
		if (!stopped.success) return stopped;
		return ok(stoppedSuccess(ctx, target, stopped.data));
	});
}

/** Wire `stop` onto `warden perf`. */
export function registerStop(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	withPerfOptions(cmd.command("stop").description("end the session: stop the captures, write report.md + report.json"))
		.option("--no-analyze", "stop only; build the report later with warden perf report")
		.option("--yes", "download tools the analysis needs (trace_processor) without asking")
		.action(async (opts) => {
			done(await perfStop(ctx, deps, opts));
		});
}
