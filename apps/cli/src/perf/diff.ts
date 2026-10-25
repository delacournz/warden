import type { Command as Commander } from "@commander-js/extra-typings";
import { DEFAULT_THRESHOLD_PCT, diffLines, diffReports } from "@delacour/warden-perf/shared/diff";
import { reportError, reportOk, UI_EXIT, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { errorMessage } from "../hooks/json";
import { reportFor } from "./report-read";
import { sessionByRef } from "./session-pick";

export type PerfDiffOptions = { json?: true; failOn?: string; threshold?: string };

/** `10%` / `10` to 10. */
function parseThreshold(raw: string | undefined): number | undefined {
	if (raw === undefined) return DEFAULT_THRESHOLD_PCT;
	const m = /^(\d+(?:\.\d+)?)%?$/.exec(raw.trim());
	return m?.[1] === undefined ? undefined : Number(m[1]);
}

/**
 * `warden perf diff <a> <b> [--fail-on regress] [--threshold 10%]`: per-metric deltas between two sessions' reports
 * (startup p50, jank %, p95 CPU, peak PSS/RSS, slowest commit, hangs, top functions' self share). Exit 1 when
 * `--fail-on regress` and something regressed past the threshold. Reads files only: no device.
 */
export async function perfDiff(ctx: CommandContext, a: string, b: string, opts: PerfDiffOptions): Promise<number> {
	const meta = { command: "perf diff", label: "perf diff", json: opts.json === true, startedAt: ctx.now() };
	try {
		if (opts.failOn !== undefined && opts.failOn !== "regress")
			return reportError(ctx, meta, uiError("usage", `--fail-on must be "regress", got "${opts.failOn}"`));
		const threshold = parseThreshold(opts.threshold);
		if (threshold === undefined)
			return reportError(
				ctx,
				meta,
				uiError("usage", `--threshold must be a percentage like 10%, got "${opts.threshold}"`)
			);
		const sessions = [sessionByRef(ctx, a), sessionByRef(ctx, b)] as const;
		for (const s of sessions) if (!s.success) return reportError(ctx, meta, s.error);
		const [first, second] = sessions;
		if (!first.success || !second.success) return UI_EXIT.failed;
		const reports = [reportFor(ctx, first.data.id), reportFor(ctx, second.data.id)] as const;
		const [ra, rb] = reports;
		if (ra === undefined || rb === undefined)
			return reportError(ctx, meta, uiError("session_not_found", "could not build a report for one of the sessions"));
		const diff = diffReports(ra, rb, threshold);
		const failed = opts.failOn === "regress" && diff.regressions > 0;
		return reportOk(ctx, meta, {
			device: { udid: rb.device.udid, platform: rb.device.platform, name: rb.device.name },
			result: { ...diff, failed },
			text: diffLines(diff).join("\n"),
			exit: failed ? UI_EXIT.failed : UI_EXIT.ok,
		});
	} catch (error) {
		return reportError(ctx, meta, uiError("failed", errorMessage(error)));
	}
}

/** Wire `diff` onto `warden perf`. */
export function registerDiff(cmd: Commander, ctx: CommandContext, done: (code: number) => void): void {
	cmd
		.command("diff")
		.description("compare two sessions' reports (before/after a fix); --fail-on regress exits 1 on a regression")
		.argument("<a>", "the baseline session id (or prefix, or latest)")
		.argument("<b>", "the session to judge")
		.option("--fail-on <what>", "regress: exit 1 when a metric got worse past the threshold")
		.option("--threshold <pct>", "relative change that counts as a regression (default 10%)")
		.option("--json", "machine-readable output")
		.action(async (a, b, opts) => {
			done(await perfDiff(ctx, a, b, opts));
		});
}
