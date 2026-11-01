import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { StartOptions } from "@delacour/warden-sdk/ops/perf/orchestrate";
import { storeLocator } from "@delacour/warden-store/store";
import { resultFactory } from "@delacour/warden-types/result";
import type { DevActionHost, DevReady, MetroTerminal } from "../commands/dev-ui";
import type { CommandContext } from "../context";
import type { PerfTarget } from "../perf/device";
import type { ActionEffects, ActionFailure, FxResult, LogStream, PerfStarted, PerfStopped } from "./actions";
import { devTuiAnsi } from "./ansi";

/**
 * The real effects behind the action keys. Everything heavy (the perf orchestrator, the `warden ui` driver, log
 * parsing) is imported inside the effect that needs it, so the dashboard itself stays cheap to load.
 */
export type EffectsDeps = {
	/** the command context (its output is not the dashboard's: each effect scopes its own) */
	ctx: CommandContext;
	/** what only `warden dev` knows; absent in tests of the dashboard */
	host(): DevActionHost | undefined;
	metroTerminal(): MetroTerminal | undefined;
	/** `$WARDEN_HOME/dev/<leaseId>/shots` once the lease id is known */
	shotsDir(): string | undefined;
};

export class DevTuiActionsEffects {
	failure(message: string, code?: ActionFailure["code"]): { success: false; error: ActionFailure } {
		return {
			success: false,
			error: { message, ...(code ? { code } : {}) },
		};
	}

	errorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	/** The next free `NNN.png` in `dir`. */
	nextShot(dir: string): string {
		mkdirSync(dir, { recursive: true });
		let highest = 0;
		for (const file of readdirSync(dir)) {
			const n = /^(\d{3,})\.png$/.exec(file)?.[1];
			if (n !== undefined) highest = Math.max(highest, Number(n));
		}
		return join(dir, `${String(highest + 1).padStart(3, "0")}.png`);
	}

	/** `ctx` with its output captured: what a CLI function printed, and its exit code. */
	async captured(
		ctx: CommandContext,
		run: (scoped: CommandContext) => Promise<number>
	): Promise<{ code: number; out: string[]; err: string[] }> {
		const out: string[] = [];
		const err: string[] = [];
		const code = await run({ ...ctx, out: (line) => out.push(line), err: (line) => err.push(line) });
		return { code, out, err };
	}

	/**
	 * Run a `warden` command function as the key's action: its stdout lines and warnings go to the row, a non-zero exit
	 * fails the row with the command's own error line.
	 */
	async viaCommand(
		ctx: CommandContext,
		log: (line: string) => void,
		run: (scoped: CommandContext) => Promise<number>
	): FxResult<undefined> {
		const { code, out, err } = await this.captured(ctx, run);
		if (code !== 0) return this.failure(devTuiAnsi.stripAnsi(err.at(-1) ?? out.at(-1) ?? `exit ${code}`));
		for (const line of [...out, ...err]) log(line);
		return resultFactory.ok(undefined);
	}

	perfTarget(info: DevReady): PerfTarget {
		return {
			udid: info.deviceId,
			platform: info.platform,
			...(info.deviceName === undefined ? {} : { name: info.deviceName }),
			ownedByCaller: true,
			source: "flag",
			mode: "observe",
		};
	}

	private needHost(): { success: false; error: ActionFailure } {
		return this.failure("not available: this session has no dev host");
	}

	createActionEffects(deps: EffectsDeps): ActionEffects {
		const { ctx } = deps;
		const scoped = (log: (line: string) => void): CommandContext => ({ ...ctx, out: log, err: log });

		return {
			metroWrite(data) {
				const terminal = deps.metroTerminal();
				if (terminal === undefined) return false;
				terminal.write(data);
				return true;
			},

			async reveal(info) {
				const { SimWindowArranger } = await import("@delacour/warden-leasing/sim-windows");
				const shown = await new SimWindowArranger(ctx).reveal(info.deviceId);
				return shown.success ? resultFactory.ok(undefined) : devTuiActionsEffects.failure(shown.error);
			},

			async screenshot(info) {
				const dir =
					deps.shotsDir() ?? join(storeLocator.wardenHome(ctx.env), "dev", info.leaseIds[0] ?? info.deviceId, "shots");
				const path = devTuiActionsEffects.nextShot(dir);
				const [{ uiControls }, { defaultUiDeps }] = await Promise.all([
					import("../agent-ui/controls"),
					import("../agent-ui/driver"),
				]);
				const done = await devTuiActionsEffects.captured(ctx, (c) =>
					uiControls.uiScreenshot(c, defaultUiDeps, path, { udid: info.deviceId, force: true, record: false })
				);
				return done.code === 0
					? resultFactory.ok(path)
					: devTuiActionsEffects.failure(devTuiAnsi.stripAnsi(done.err.at(-1) ?? `exit ${done.code}`));
			},

			openClient: (log) => deps.host()?.openClient(log).then(this.toFx) ?? Promise.resolve(this.needHost()),
			reinstall: (log) => deps.host()?.reinstall(log).then(this.toFx) ?? Promise.resolve(this.needHost()),
			restartSim: (log) => deps.host()?.restartSim(log).then(this.toFx) ?? Promise.resolve(this.needHost()),
			restartMetro: (log) => deps.host()?.restartMetro(log).then(this.toFx) ?? Promise.resolve(this.needHost()),

			streamLogs(info, onLine): LogStream {
				const controller = new AbortController();
				const done = (async (): Promise<string | undefined> => {
					if (info.bundleId === undefined) return "no bundle id for the dev client";
					const [{ perfLogsOps }, { logMatcher }] = await Promise.all([
						import("@delacour/warden-sdk/ops/perf/logs"),
						import("@delacour/warden-perf/logs/filter"),
					]);
					const year = new Date(ctx.now()).getFullYear();
					const ended = await perfLogsOps.streamAppLogs(
						ctx,
						{ udid: info.deviceId, platform: info.platform },
						{ id: info.bundleId },
						{
							signal: controller.signal,
							onLine: (raw) => {
								const entry = perfLogsOps.parseLogLine(info.platform, raw, year);
								if (entry !== undefined) onLine(logMatcher.formatEntry(entry));
							},
						}
					);
					return ended.success ? undefined : ended.error.message;
				})().catch((error: unknown) => devTuiActionsEffects.errorText(error));
				return { stop: () => controller.abort(), done };
			},

			async perfStart(info, mode, log): FxResult<PerfStarted> {
				const [{ perfOrchestrator }, { defaultSessionKit }, { defaultPerfDeps }] = await Promise.all([
					import("@delacour/warden-sdk/ops/perf/orchestrate"),
					import("../perf/session-kit"),
					import("../perf/run"),
				]);
				const app = info.bundleId === undefined ? {} : { app: info.bundleId };
				const options: StartOptions =
					mode === "all"
						? { all: true, relaunch: true, ...app }
						: { metrics: true, logs: true, ...(info.platform === "android" ? { frames: true } : {}), ...app };
				const started = await perfOrchestrator.startPerf(
					scoped(log),
					defaultPerfDeps,
					defaultSessionKit,
					devTuiActionsEffects.perfTarget(info),
					options
				);
				if (!started.success) {
					const { code, message } = started.error;
					return devTuiActionsEffects.failure(message, code === "session_active" ? "session_active" : undefined);
				}
				const { session, warnings } = started.data;
				const captures = session.capturers.filter((c) => c.kind !== "collector");
				return resultFactory.ok({
					sessionId: session.id,
					startedAt: session.startedAt.wallMs,
					maxDurationMs: session.maxDurationMs,
					armed: captures.filter((c) => c.state === "running").map((c) => c.kind),
					failed: captures.filter((c) => c.state === "failed").map((c) => c.kind),
					warnings,
				});
			},

			async perfStop(info, sessionId, log): FxResult<PerfStopped> {
				const [
					{ perfOrchestrator },
					{ defaultSessionKit },
					{ defaultPerfDeps },
					{ reportBuilder },
					{ MAX_TEXT_LINES },
				] = await Promise.all([
					import("@delacour/warden-sdk/ops/perf/orchestrate"),
					import("../perf/session-kit"),
					import("../perf/run"),
					import("@delacour/warden-perf/shared/report"),
					import("@delacour/warden-perf/shared/caps"),
				]);
				void info;
				const stopped = await perfOrchestrator.finalizeSession(
					scoped(log),
					defaultPerfDeps,
					defaultSessionKit,
					sessionId,
					{
						reason: "user",
						analyze: true,
					}
				);
				if (!stopped.success) {
					const { code, message } = stopped.error;
					return devTuiActionsEffects.failure(message, code === "session_not_found" ? "session_not_found" : undefined);
				}
				const { report, reportPath, warnings } = stopped.data;
				return resultFactory.ok({
					reportPath,
					lines:
						report === undefined
							? []
							: reportBuilder.renderReportMarkdown(report, { maxLines: MAX_TEXT_LINES }).split("\n"),
					warnings,
				});
			},

			async perfMark(info, label, log) {
				const [{ perfMarkCli }, { defaultPerfDeps }] = await Promise.all([
					import("../perf/mark"),
					import("../perf/run"),
				]);
				return devTuiActionsEffects.viaCommand(ctx, log, (c) =>
					perfMarkCli.perfMark(c, defaultPerfDeps, [label], { udid: info.deviceId })
				);
			},

			async frames(info, log) {
				const [{ perfFramesCli }, { defaultPerfDeps }] = await Promise.all([
					import("../perf/frames"),
					import("../perf/run"),
				]);
				return devTuiActionsEffects.viaCommand(ctx, log, (c) =>
					perfFramesCli.perfFrames(c, defaultPerfDeps, {
						udid: info.deviceId,
						...(info.bundleId === undefined ? {} : { app: info.bundleId }),
					})
				);
			},

			async report(info, log) {
				const [{ perfReportCli }, { defaultPerfDeps }] = await Promise.all([
					import("../perf/report"),
					import("../perf/run"),
				]);
				return devTuiActionsEffects.viaCommand(ctx, log, (c) =>
					perfReportCli.perfReport(c, defaultPerfDeps, undefined, { udid: info.deviceId })
				);
			},
		};
	}

	/** A host result (`AsyncResult`, string errors) as an effect result. */
	private readonly toFx = <T>(result: { success: true; data: T } | { success: false; error: string }) => {
		return result.success ? result : this.failure(result.error);
	};
}

export const devTuiActionsEffects = new DevTuiActionsEffects();
