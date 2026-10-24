import { defineCommand } from "../command";
import type { CommandContext } from "../context";
import { reportError } from "../output";
import { runAutoStop } from "../perf/auto-stop";
import { defaultSessionDeps, readSession, type SessionDeps, updateSession } from "../perf/session";

/** What `perf-collect` reaches the outside world through; tests inject a sleep and a process table. */
export type PerfCollectDeps = {
	sleep?: (ms: number) => Promise<void>;
	signal?: AbortSignal;
	session?: SessionDeps;
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
		await runAutoStop(ctx, deps.session ?? defaultSessionDeps, id, {
			sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
			signal: controller.signal,
		});
		return 0;
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
