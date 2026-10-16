import { join } from "node:path";
import type { SelectedFlow } from "@delacour/warden-core/affected/select";
import { readResults } from "@delacour/warden-e2e/runner/results";
import { realPath } from "../batch/flow-progress";
import { attemptKey } from "../commands/batch";
import { shardFlows } from "./bun-runner";
import { judgeJob } from "./verdicts";

/** The batch jobs of a run and the `bun test` argv of each. */
export type JobPlan = {
	jobs: string[];
	argvs: Map<string, string[]>;
	/** device isolation: the shard job each flow runs in */
	shardOf?: Map<string, string>;
	/** device isolation: the flows of each shard job, in run order */
	shards?: Map<string, SelectedFlow[]>;
};

/**
 * The batch jobs and the `bun test` argv of each. `shards` undefined: one job per flow. Otherwise
 * (device isolation) one `shard-<k>` job per device over its round-robin share of the flows, so a
 * device pays bun's start, the preload and the driver connect once instead of once per flow.
 */
export function jobPlan(
	flows: readonly SelectedFlow[],
	shards: number | undefined,
	argvOf: (files: readonly string[]) => string[]
): JobPlan {
	const argvs = new Map<string, string[]>();
	if (shards === undefined) {
		for (const flow of flows) argvs.set(flow.id, argvOf([flow.file]));
		return { jobs: flows.map((f) => f.id), argvs };
	}
	const shardOf = new Map<string, string>();
	const byShard = new Map<string, SelectedFlow[]>();
	shardFlows(flows, shards).forEach((share, k) => {
		const job = `shard-${k}`;
		argvs.set(job, argvOf(share.map((f) => f.file)));
		byShard.set(job, share);
		for (const flow of share) shardOf.set(flow.id, job);
	});
	return { jobs: [...argvs.keys()], argvs, shardOf, shards: byShard };
}

/** Where the spec process of attempt `seq` on `worker` writes `results.jsonl` and its artifacts (`WARDEN_E2E_OUT`). */
export const attemptOut = (batchDir: string, worker: number, seq: number): string =>
	join(batchDir, "e2e", `${worker}-${seq}`);

/** One spawn of a job, as the batch asks for its argv. */
export type AttemptRun = { job: string; worker: number; seq: number; attempt: number; batchDir: string };

export type ShardRunsIO = {
	argvOf: (files: readonly string[]) => string[];
	readFile: (path: string) => Promise<string>;
	real?: (path: string) => string;
};

export type ShardRuns = {
	/** the argv of this attempt: the whole shard first, then (a retry) only the flows the attempt before it did not pass */
	argv: (run: AttemptRun) => Promise<string[]>;
	/** the flow ids each attempt (`attemptKey`) of a shard job ran; flow-isolated jobs are not listed */
	attempts: ReadonlyMap<string, ReadonlySet<string>>;
};

/** A shard job on one worker: the flows of its latest attempt, and where that attempt wrote its results. */
type ShardState = { attempt: number; flows: readonly SelectedFlow[]; out: string };

/**
 * Retries of a device's shard rerun only what did not pass. A retry reads the results the failed
 * attempt left (`judgeJob` with a failing exit code): flows whose tests passed stay passed, a flow
 * with a failed test, the one running when the process died and the ones it never reached run again.
 * When the results say nothing (none written, or every test passed and the process failed anyway)
 * the whole attempt reruns. A job is followed per worker: a retry runs on the worker that failed,
 * and device legs run the same shard job on different workers.
 */
export function shardRuns(plan: JobPlan, io: ShardRunsIO): ShardRuns {
	const states = new Map<string, ShardState>();
	const attempts = new Map<string, Set<string>>();
	const real = io.real ?? realPath;
	const failedFlows = async (state: ShardState): Promise<SelectedFlow[]> => {
		const text = await io.readFile(join(state.out, "results.jsonl")).catch(() => undefined);
		const judged = judgeJob(state.flows, text === undefined ? undefined : readResults(text), 1, real);
		const failed = state.flows.filter((f) => judged.get(f.id)?.verdict !== "passed");
		return failed.length > 0 ? failed : [...state.flows];
	};
	return {
		attempts,
		async argv(run) {
			const shard = plan.shards?.get(run.job);
			if (!shard) return plan.argvs.get(run.job) ?? [];
			const key = `${run.worker}:${run.job}`;
			const out = attemptOut(run.batchDir, run.worker, run.seq);
			const known = states.get(key);
			let state: ShardState;
			if (!known) state = { attempt: run.attempt, flows: shard, out };
			else if (run.attempt > known.attempt) state = { attempt: run.attempt, flows: await failedFlows(known), out };
			else state = known;
			states.set(key, state);
			attempts.set(attemptKey(run), new Set(state.flows.map((f) => f.id)));
			return io.argvOf(state.flows.map((f) => f.file));
		},
	};
}
