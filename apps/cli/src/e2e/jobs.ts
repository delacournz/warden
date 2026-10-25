import { join } from "node:path";
import type { SelectedSpec } from "@delacour/warden-core/affected/select";
import { readResults } from "@delacour/warden-e2e/runner/results";
import { realPath } from "../batch/spec-progress";
import { attemptKey } from "../commands/batch";
import { shardSpecs } from "./bun-runner";
import { judgeJob } from "./verdicts";

/** The batch jobs of a run and the `bun test` argv of each. */
export type JobPlan = {
	jobs: string[];
	argvs: Map<string, string[]>;
	/** device isolation: the shard job each spec runs in */
	shardOf?: Map<string, string>;
	/** device isolation: the specs of each shard job, in run order */
	shards?: Map<string, SelectedSpec[]>;
};

/**
 * The batch jobs and the `bun test` argv of each. `shards` undefined: one job per spec. Otherwise
 * (device isolation) one `shard-<k>` job per device over its round-robin share of the specs, so a
 * device pays bun's start, the preload and the driver connect once instead of once per spec.
 */
export function jobPlan(
	specs: readonly SelectedSpec[],
	shards: number | undefined,
	argvOf: (files: readonly string[]) => string[]
): JobPlan {
	const argvs = new Map<string, string[]>();
	if (shards === undefined) {
		for (const spec of specs) argvs.set(spec.id, argvOf([spec.file]));
		return { jobs: specs.map((f) => f.id), argvs };
	}
	const shardOf = new Map<string, string>();
	const byShard = new Map<string, SelectedSpec[]>();
	shardSpecs(specs, shards).forEach((share, k) => {
		const job = `shard-${k}`;
		argvs.set(job, argvOf(share.map((f) => f.file)));
		byShard.set(job, share);
		for (const spec of share) shardOf.set(spec.id, job);
	});
	return { jobs: [...argvs.keys()], argvs, shardOf, shards: byShard };
}

/**
 * Where the spec process of attempt `seq` on `worker` writes `results.jsonl` and its artifacts
 * (`WARDEN_E2E_OUT`); a later pass (`pass` > 0) of the attempt gets its own `-p<pass>` directory (12-10).
 */
export const attemptOut = (batchDir: string, worker: number, seq: number, pass = 0): string =>
	join(batchDir, "e2e", `${worker}-${seq}${pass > 0 ? `-p${pass}` : ""}`);

/** One spawn of a job, as the batch asks for its argv. */
export type AttemptRun = { job: string; worker: number; seq: number; attempt: number; batchDir: string };

export type ShardRunsIO = {
	argvOf: (files: readonly string[]) => string[];
	readFile: (path: string) => Promise<string>;
	real?: (path: string) => string;
};

export type ShardRuns = {
	/** the argv of this attempt: the whole shard first, then (a retry) only the specs the attempt before it did not pass */
	argv: (run: AttemptRun) => Promise<string[]>;
	/** the spec ids each attempt (`attemptKey`) of a shard job ran; spec-isolated jobs are not listed */
	attempts: ReadonlyMap<string, ReadonlySet<string>>;
};

/** A shard job on one worker: the specs of its latest attempt, and where that attempt wrote its results. */
type ShardState = { attempt: number; specs: readonly SelectedSpec[]; out: string };

/**
 * Retries of a device's shard rerun only what did not pass. A retry reads the results the failed
 * attempt left (`judgeJob` with a failing exit code): specs whose tests passed stay passed, a spec
 * with a failed test, the one running when the process died and the ones it never reached run again.
 * When the results say nothing (none written, or every test passed and the process failed anyway)
 * the whole attempt reruns. A job is followed per worker: a retry runs on the worker that failed,
 * and device legs run the same shard job on different workers.
 */
export function shardRuns(plan: JobPlan, io: ShardRunsIO): ShardRuns {
	const states = new Map<string, ShardState>();
	const attempts = new Map<string, Set<string>>();
	const real = io.real ?? realPath;
	const failedSpecs = async (state: ShardState): Promise<SelectedSpec[]> => {
		const text = await io.readFile(join(state.out, "results.jsonl")).catch(() => undefined);
		const judged = judgeJob(state.specs, text === undefined ? undefined : readResults(text), 1, real);
		const failed = state.specs.filter((f) => judged.get(f.id)?.verdict !== "passed");
		return failed.length > 0 ? failed : [...state.specs];
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
			if (!known) state = { attempt: run.attempt, specs: shard, out };
			else if (run.attempt > known.attempt) state = { attempt: run.attempt, specs: await failedSpecs(known), out };
			else state = known;
			states.set(key, state);
			attempts.set(attemptKey(run), new Set(state.specs.map((f) => f.id)));
			return io.argvOf(state.specs.map((f) => f.file));
		},
	};
}
