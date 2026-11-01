import { autoStop } from "@delacour/warden-sdk/ops/perf/auto-stop";
import type { SessionKit } from "@delacour/warden-sdk/ops/perf/orchestrate";
import { perfPlans } from "@delacour/warden-sdk/ops/perf/plan";
import { defaultSessionDeps, perfSessionStore, type SessionDeps } from "@delacour/warden-sdk/ops/perf/session";
import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { output } from "../output";
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

export class PerfCollectCommand extends CliCommand {
	override readonly name = "perf-collect";
	override readonly summary = "background sampler + auto-stop timer for `warden perf start` (internal)";
	override readonly hidden = true;

	constructor(private readonly deps: PerfCollectDeps = {}) {
		super();
	}

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd.option("--session <id>").action(async (opts) => done(await this.collect(ctx, this.deps, opts.session)));
	}

	private async collect(ctx: CommandContext, deps: PerfCollectDeps, id: string | undefined): Promise<number> {
		if (id === undefined) {
			output.reportError(ctx, "perf-collect", "--session <id> is required");
			return 1;
		}
		const session = perfSessionStore.readSession(ctx, id);
		if (session === undefined || session.status !== "running") {
			output.reportError(ctx, "perf-collect", `no running perf session ${id}`);
			return 1;
		}
		const controller = new AbortController();
		const stop = () => controller.abort();
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		deps.signal?.addEventListener("abort", stop, { once: true });
		try {
			perfSessionStore.updateSession(ctx, id, (s) => ({
				...s,
				capturers: [
					...s.capturers.filter((c) => c.kind !== "collector"),
					{ kind: "collector", pid: process.pid, startedAtIso: new Date(ctx.now()).toISOString(), state: "running" },
				],
			}));
			if (perfPlans.readPlan(ctx, id) === undefined) {
				await autoStop.runAutoStop(ctx, deps.session ?? defaultSessionDeps, id, {
					sleep: deps.sleep ?? ((ms) => Bun.sleep(ms)),
					signal: controller.signal,
				});
				return 0;
			}
			const { runSessionCollector, defaultCollectorDeps } = await import("../perf/collector");
			const { perfOrchestrator } = await import("@delacour/warden-sdk/ops/perf/orchestrate");
			const { defaultSessionKit } = await import("../perf/session-kit");
			const { defaultPerfDeps } = await import("../perf/run");
			const perf = deps.perf ?? defaultPerfDeps;
			const kit = deps.kit ?? defaultSessionKit;
			const collectorDeps: CollectorDeps = {
				...defaultCollectorDeps((line) => ctx.err(line)),
				...deps.collector,
				finalize: (sessionId) =>
					perfOrchestrator.finalizeSession(ctx, perf, kit, sessionId, { reason: "max-duration", fromCollector: true }),
			};
			const outcome = await runSessionCollector(ctx, perf, collectorDeps, id, controller.signal);
			return outcome.success ? 0 : 1;
		} finally {
			process.off("SIGTERM", stop);
			process.off("SIGINT", stop);
		}
	}
}

export const perfCollectCommand = new PerfCollectCommand().definition();
