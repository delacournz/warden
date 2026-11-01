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
import { UI_EXIT, type UiError, uiOutput } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { hookJson } from "../hooks/json";
import { perfAppCli } from "./app";
import { perfDeviceCli } from "./device";
import { perfOptionsCli } from "./options";
import { type PerfDeps, type PerfOptionValues, perfRunCli } from "./run";
export type PerfLogsOptions = PerfOptionValues & LogFlags & { follow?: true };

const LEVEL_HELP: LogLevel[] = [...LOG_LEVELS];

export class PerfLogsCli {
	/**
	 * `warden perf logs`: the app's recent device logs (redacted), or with `--follow` a live stream (NDJSON under
	 * `--json`; Ctrl-C exits 130). An `observe` op: needs no lease.
	 */
	async perfLogs(
		ctx: CommandContext,
		deps: PerfDeps,
		opts: PerfLogsOptions,
		logDeps: LogDeps = defaultLogDeps
	): Promise<number> {
		const flags = perfLogsOps.parseFlags(opts);
		if (opts.follow === true) return this.followLogs(ctx, deps, opts, flags, logDeps);
		return perfRunCli.runPerf(ctx, deps, "logs", "observe", opts, async (target, env) => {
			if (!flags.success) return flags;
			const app = await perfAppCli.resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
			if (!app.success) return app;
			return perfLogsOps.logsWork(ctx, target, app.data, flags.data, env.timeoutMs);
		});
	}

	private async followLogs(
		ctx: CommandContext,
		deps: PerfDeps,
		opts: PerfLogsOptions,
		flags: Result<ParsedFlags, UiError>,
		logDeps: LogDeps
	): Promise<number> {
		const json = opts.json === true;
		const report = { command: "perf logs", label: "perf logs", json, startedAt: ctx.now() };
		try {
			if (!flags.success) return uiOutput.reportError(ctx, report, flags.error);
			const target = await perfDeviceCli.resolvePerfDevice(ctx, opts, "observe", deps.device);
			if (!target.success) return uiOutput.reportError(ctx, report, target.error);
			const info = { udid: target.data.udid, platform: target.data.platform, name: target.data.name };
			const app = await perfAppCli.resolveApp(ctx, { platform: target.data.platform, id: target.data.udid }, opts.app);
			if (!app.success) return uiOutput.reportError(ctx, report, app.error, info);
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
				if (!done.success) return uiOutput.reportError(ctx, report, done.error, info);
				return interrupt.signal.aborted ? UI_EXIT.interrupted : UI_EXIT.ok;
			} finally {
				interrupt.dispose();
			}
		} catch (error) {
			return uiOutput.reportError(ctx, report, uiOutput.uiError("failed", hookJson.errorMessage(error)));
		}
	}

	/** Wire `logs` onto `warden perf`. */
	readonly registerLogs = (cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps): void => {
		perfOptionsCli
			.withPerfOptions(
				cmd
					.command("logs")
					.description("the app's device logs, secrets redacted (--follow streams; Ctrl-C exits 130)")
					.option("-f, --follow", "stream live (text lines, or NDJSON with --json)")
					.option("--level <level>", `minimum level: ${LEVEL_HELP.join(" ")} (default: all)`)
					.option("--grep <regex>", "keep lines whose tag or message matches (case-insensitive)")
					.option("--since <duration>", "only lines from the last 30s | 5m | 1h")
					.option("-n, --lines <n>", `lines to show, newest last (default ${DEFAULT_LOG_LINES})`)
			)
			.action(async (opts) => {
				done(await this.perfLogs(ctx, deps, opts));
			});
	};
}

export const perfLogsCli = new PerfLogsCli();
