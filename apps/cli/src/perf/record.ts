import type { Command as Commander } from "@commander-js/extra-typings";
import { perfDuration } from "@delacour/warden-perf/metrics/duration";
import { HARD_MAX_DURATION_MS } from "@delacour/warden-perf/shared/caps";
import { perfOrchestrator, type SessionKit } from "@delacour/warden-sdk/ops/perf/orchestrate";
import { resultFactory } from "@delacour/warden-types/result";
import { UI_EXIT, uiOutput } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { type PerfDeps, perfRunCli } from "./run";
import { defaultSessionKit, perfSessionKitCli } from "./session-kit";
import { type PerfStartOptions, perfStartCli } from "./start";
import { perfStopCli } from "./stop";

export type PerfRecordOptions = PerfStartOptions & { duration?: string; analyze?: boolean };

const DEFAULT_DURATION_MS = 10_000;
/** headroom past `--duration` before the session's own cap would end it */
const CAP_SLACK_MS = 10_000;

/** Ctrl-C as an abort signal; tests inject their own. */
export type RecordIo = { interrupt: () => { signal: AbortSignal; dispose: () => void } };

export const defaultRecordIo: RecordIo = {
	interrupt: () => {
		const controller = new AbortController();
		const onSigint = () => controller.abort();
		process.once("SIGINT", onSigint);
		return { signal: controller.signal, dispose: () => process.off("SIGINT", onSigint) };
	},
};

export class PerfRecordCli {
	/** Resolve after `ms` (via the injected sleep), or as soon as `signal` aborts; true when it was interrupted. */
	private async sleepOrInterrupt(
		sleep: (ms: number) => Promise<void>,
		ms: number,
		signal: AbortSignal
	): Promise<boolean> {
		if (signal.aborted) return true;
		const aborted = new Promise<true>((resolve) =>
			signal.addEventListener("abort", () => resolve(true), { once: true })
		);
		return Promise.race([sleep(ms).then(() => false as const), aborted]);
	}

	/**
	 * `warden perf record --duration 10s [same flags as start]`: start, wait, stop, report. Ctrl-C ends the wait early
	 * (the session is still stopped and reported, exit 130). The session cap defaults to the duration plus 10s.
	 */
	perfRecord(
		ctx: CommandContext,
		deps: PerfDeps,
		opts: PerfRecordOptions,
		kit: SessionKit = defaultSessionKit,
		io: RecordIo = defaultRecordIo
	): Promise<number> {
		return perfRunCli.runPerf(ctx, deps, "record", "observe", opts, async (target) => {
			const durationMs = opts.duration === undefined ? DEFAULT_DURATION_MS : perfDuration.parseDuration(opts.duration);
			if (durationMs === undefined || durationMs > HARD_MAX_DURATION_MS) {
				return {
					success: false,
					error: uiOutput.uiError(
						"usage",
						`--duration must be a duration like 10s or 2m, at most 5m, got "${opts.duration}"`
					),
				};
			}
			const maxDuration = opts.maxDuration ?? `${Math.ceil((durationMs + CAP_SLACK_MS) / 1000)}s`;
			const started = await perfOrchestrator.startPerf(
				ctx,
				deps,
				kit,
				target,
				{ ...opts, maxDuration },
				perfSessionKitCli.startHooks(ctx, deps, opts)
			);
			if (!started.success) return started;
			const interrupt = io.interrupt();
			let interrupted: boolean;
			try {
				interrupted = await this.sleepOrInterrupt(kit.io.sleep, durationMs, interrupt.signal);
			} finally {
				interrupt.dispose();
			}
			const stopped = await perfOrchestrator.finalizeSession(ctx, deps, kit, started.data.session.id, {
				reason: "user",
				analyze: opts.analyze !== false,
				...(opts.yes === true ? { yes: true } : {}),
			});
			if (!stopped.success) return stopped;
			const success = perfStopCli.stoppedSuccess(ctx, target, {
				...stopped.data,
				warnings: [...started.data.warnings, ...stopped.data.warnings],
			});
			return resultFactory.ok({ ...success, ...(interrupted ? { exit: UI_EXIT.interrupted } : {}) });
		});
	}

	/** Wire `record` onto `warden perf`. */
	readonly registerRecord = (
		cmd: Commander,
		ctx: CommandContext,
		done: (code: number) => void,
		deps: PerfDeps
	): void => {
		perfStartCli
			.withCaptureOptions(
				cmd.command("record").description("start, wait --duration, stop and report in one call (Ctrl-C stops early)")
			)
			.option("--duration <time>", "how long to record (default 10s, max 5m)")
			.option("--no-analyze", "stop without building the report")
			.action(async (opts) => {
				done(await this.perfRecord(ctx, deps, opts));
			});
	};
}

export const perfRecordCli = new PerfRecordCli();
