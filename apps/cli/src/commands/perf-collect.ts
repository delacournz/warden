import { runAutoStop } from "@delacour/warden-sdk/ops/perf/auto-stop";
import type { SessionKit } from "@delacour/warden-sdk/ops/perf/orchestrate";
import { readPlan } from "@delacour/warden-sdk/ops/perf/plan";
import {
	defaultSessionDeps,
	readSession,
	type SessionDeps,
	updateSession,
} from "@delacour/warden-sdk/ops/perf/session";
import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";
import type { CollectorDeps } from "../perf/collector";
import type { PerfDeps } from "../perf/run";

/** What `perf-collect` reaches the outside world through; tests inject a sleep and a process table. */
export type PerfCollectDeps = {
	sleep?: (ms: number) => Promise<void>;
	signal?: AbortSignal;
	session?: SessionDeps;
	/** the session collector's effects (Metro, logs, sleep); tests inject fakes */
	collector?: Partial<CollectorDeps>;
	perf?: PerfDeps;
	kit?: SessionKit;
};

async function collect(ctx: CommandContext, deps: PerfCollectDeps, id: string | undefined): Promise<number> {
	if (id === undefined) {
		reportError(ctx, "perf-collect", "--session <id> is required");
		return 1;
	}
	const session = readSession(ctx, id);
	if (session === undefined || session.status !== "running") {
		reportError(ctx, "perf-collect", `no running perf session ${id}`);
		return 1;
	}
	const controller = new AbortController();
	const stop = () => controller.abort();
	process.once("SIGTERM", stop);
	process.once("SIGINT", stop);
	deps.signal?.addEventListener("abort", stop, { once: true });
	try {
		updateSession(ctx, id, (s) => ({
			...s,
			capturers: [
				...s.capturers.filter((c) => c.kind !== "collector"),
				{ kind: "collector", pid: process.pid, startedAtIso: new Date(ctx.now()).toISOString(), state: "running" },
			],
		}));
		if (readPlan(ctx, id) === undefined) {
			await runAutoStop(ctx, deps.session ?? defaultSessionDeps, id, {
				sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
				signal: controller.signal,
			});
			return 0;
		}
		const { runSessionCollector, defaultCollectorDeps } = await import("../perf/collector");
		const { finalizeSession } = await import("@delacour/warden-sdk/ops/perf/orchestrate");
		const { defaultSessionKit } = await import("../perf/session-kit");
		const { defaultPerfDeps } = await import("../perf/run");
		const perf = deps.perf ?? defaultPerfDeps;
		const kit = deps.kit ?? defaultSessionKit;
		const collectorDeps: CollectorDeps = {
			...defaultCollectorDeps((line) => ctx.err(line)),
			...deps.collector,
			finalize: (sessionId) =>
				finalizeSession(ctx, perf, kit, sessionId, { reason: "max-duration", fromCollector: true }),
		};
		const outcome = await runSessionCollector(ctx, perf, collectorDeps, id, controller.signal);
		return outcome.success ? 0 : 1;
	} finally {
		process.off("SIGTERM", stop);
		process.off("SIGINT", stop);
	}
}

/**
 * `warden perf-collect --session <id>`: the detached worker behind `warden perf start`. It records its pid as the
 * session's collector and owns the auto-stop timer (the session's `maxDurationMs`, 30 s by default, 5 m at most);
 * later phases run the samplers and loggers here too. Exit 0 ended · 1 bad arguments or no such session.
 */
export function createPerfCollectCommand(deps: PerfCollectDeps = {}) {
	return defineCommand({
		name: "perf-collect",
		summary: "background sampler + auto-stop timer for `warden perf start` (internal)",
		hidden: true,
		register: (cmd, ctx, done) => {
			cmd.option("--session <id>").action(async (opts) => done(await collect(ctx, deps, opts.session)));
		},
	});
}

export const perfCollectCommand = createPerfCollectCommand();
