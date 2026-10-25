import type { Command as Commander } from "@commander-js/extra-typings";
import { MAX_TEXT_LINES } from "@delacour/warden-perf/shared/caps";
import { renderReportMarkdown } from "@delacour/warden-perf/shared/report";
import { reportError, reportOk, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { errorMessage } from "../hooks/json";
import { withPerfOptions } from "./options";
import { sessionDir } from "./paths";
import { readSessionReport, writeSessionReport } from "./report-read";
import type { PerfDeps, PerfOptionValues } from "./run";
import { pickSession } from "./session-pick";

export type PerfReportOptions = PerfOptionValues & { full?: boolean; rebuild?: boolean };

/**
 * `warden perf report [id]`: the merged report of a session (default: the newest for the resolved device, else the
 * newest overall). Built from the session's files when it has no `report.json` yet (or with `--rebuild`, e.g. after
 * `perf stop --no-analyze`). `--full` prints all of `report.md` instead of the capped view.
 */
export async function perfReport(
	ctx: CommandContext,
	deps: PerfDeps,
	id: string | undefined,
	opts: PerfReportOptions
): Promise<number> {
	const meta = { command: "perf report", label: "perf report", json: opts.json === true, startedAt: ctx.now() };
	try {
		const picked = await pickSession(ctx, deps, opts, id);
		if (!picked.success) return reportError(ctx, meta, picked.error);
		const session = picked.data;
		if (session.status === "running") {
			return reportError(
				ctx,
				meta,
				uiError("session_active", `session ${session.id} is still running`, { hint: "warden perf stop" })
			);
		}
		const report =
			opts.rebuild === true
				? writeSessionReport(ctx, session)
				: (readSessionReport(ctx, session.id) ?? writeSessionReport(ctx, session));
		const text = renderReportMarkdown(report, opts.full === true ? {} : { maxLines: MAX_TEXT_LINES });
		return reportOk(ctx, meta, {
			device: { udid: report.device.udid, platform: report.device.platform, name: report.device.name },
			result: { sessionId: session.id, dir: sessionDir(ctx, session.id), report },
			text,
		});
	} catch (error) {
		return reportError(ctx, meta, uiError("failed", errorMessage(error)));
	}
}

/** Wire `report` onto `warden perf`. */
export function registerReport(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: PerfDeps
): void {
	withPerfOptions(
		cmd
			.command("report")
			.description("the merged report of a session (default: the newest for the device)")
			.argument("[id]", "session id, unique prefix, or latest")
			.option("--full", "print the whole report.md, not the capped view")
			.option("--rebuild", "regenerate report.md + report.json from the session's files")
	).action(async (id, opts) => {
		done(await perfReport(ctx, deps, id, opts));
	});
}
