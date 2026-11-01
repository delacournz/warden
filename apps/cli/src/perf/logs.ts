import type { Command as Commander } from "@commander-js/extra-typings";
import { type LogFilter, logMatcher } from "@delacour/warden-perf/logs/filter";
import { LOG_LEVELS, type LogLevel } from "@delacour/warden-perf/logs/levels";
import {
	DEFAULT_LOG_LINES,
	defaultLogDeps,
	type LogDeps,
	type LogFlags,
	type ParsedFlags,
	perfLogsOps,
} from "@delacour/warden-sdk/ops/perf/logs";
import type { Result } from "@delacour/warden-types/result";
import { reportError, UI_EXIT, type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { errorMessage } from "../hooks/json";
import { resolveApp } from "./app";
import { resolvePerfDevice } from "./device";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";
export type PerfLogsOptions = PerfOptionValues & LogFlags & { follow?: true };

/**
 * `warden perf logs`: the app's recent device logs (redacted), or with `--follow` a live stream (NDJSON under
 * `--json`; Ctrl-C exits 130). An `observe` op: needs no lease.
 */
export async function perfLogs(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfLogsOptions,
	logDeps: LogDeps = defaultLogDeps
): Promise<number> {
	const flags = perfLogsOps.parseFlags(opts);
	if (opts.follow === true) return followLogs(ctx, deps, opts, flags, logDeps);
	return runPerf(ctx, deps, "logs", "observe", opts, async (target, env) => {
		if (!flags.success) return flags;
		const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		return perfLogsOps.logsWork(ctx, target, app.data, flags.data, env.timeoutMs);
	});
}

async function followLogs(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfLogsOptions,
	flags: Result<ParsedFlags, UiError>,
	logDeps: LogDeps
): Promise<number> {
	const json = opts.json === true;
	const report = { command: "perf logs", label: "perf logs", json, startedAt: ctx.now() };
	try {
		if (!flags.success) return reportError(ctx, report, flags.error);
		const target = await resolvePerfDevice(ctx, opts, "observe", deps.device);
		if (!target.success) return reportError(ctx, report, target.error);
		const info = { udid: target.data.udid, platform: target.data.platform, name: target.data.name };
		const app = await resolveApp(ctx, { platform: target.data.platform, id: target.data.udid }, opts.app);
		if (!app.success) return reportError(ctx, report, app.error, info);
		const filter: LogFilter = { ...flags.data.filter };
		const naiveNow = await perfLogsOps.deviceNaiveNow(ctx, target.data);
		if (flags.data.sinceDurationMs !== undefined) filter.sinceMs = naiveNow - flags.data.sinceDurationMs;
		const year = new Date(naiveNow).getUTCFullYear();
		const interrupt = logDeps.interrupt();
		try {
			const done = await perfLogsOps.streamAppLogs(
				ctx,
				target.data,
				app.data,
				{
					signal: interrupt.signal,
					onLine: (raw) => {
						const entry = perfLogsOps.parseLogLine(target.data.platform, raw, year);
						if (entry === undefined || !logMatcher.matchesFilter(entry, filter)) return;
						ctx.out(json ? JSON.stringify(entry) : logMatcher.formatEntry(entry));
					},
				},
				logDeps
			);
			if (!done.success) return reportError(ctx, report, done.error, info);
			return interrupt.signal.aborted ? UI_EXIT.interrupted : UI_EXIT.ok;
		} finally {
			interrupt.dispose();
		}
	} catch (error) {
		return reportError(ctx, report, uiError("failed", errorMessage(error)));
	}
}

const LEVEL_HELP: LogLevel[] = [...LOG_LEVELS];

/** Wire `logs` onto `warden perf`. */
export function registerLogs(cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void {
	withPerfOptions(
		cmd
			.command("logs")
			.description("the app's device logs, secrets redacted (--follow streams; Ctrl-C exits 130)")
			.option("-f, --follow", "stream live (text lines, or NDJSON with --json)")
			.option("--level <level>", `minimum level: ${LEVEL_HELP.join(" ")} (default: all)`)
			.option("--grep <regex>", "keep lines whose tag or message matches (case-insensitive)")
			.option("--since <duration>", "only lines from the last 30s | 5m | 1h")
			.option("-n, --lines <n>", `lines to show, newest last (default ${DEFAULT_LOG_LINES})`)
	).action(async (opts) => {
		done(await perfLogs(ctx, deps, opts));
	});
}
