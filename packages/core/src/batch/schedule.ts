/** One leased device = one worker; `worker` is its 0-based index. */
export type BatchWorker = { worker: number; udid: string };

/** One attempt of a job. `seq` counts the runs on this worker (0-based, retries included). */
export type JobRun = { job: string; worker: number; udid: string; seq: number; attempt: number };

export type JobResult = JobRun & { startedAt: number; endedAt: number; exitCode: number };

export type BatchEvent =
	| ({ type: "job-start"; at: number } & JobRun)
	| ({ type: "job-end"; willRetry: boolean } & JobResult)
	| { type: "worker-idle"; worker: number; udid: string; at: number }
	/** a worker added mid-run (`BatchHandle.addWorker`); the initial workers emit none */
	| { type: "worker-join"; worker: number; udid: string; at: number }
	| { type: "done"; ok: boolean; stopped: boolean; at: number };

export type BatchSummary = {
	/** every job passed (after retries) and the batch wasn't stopped */
	ok: boolean;
	/** every attempt, in the order they ended */
	results: JobResult[];
	/** jobs whose last attempt failed */
	failed: string[];
	/** `signal` aborted before the queue drained */
	stopped: boolean;
};

/** Handed to `onStart`: lets workers join a run already under way. */
export type BatchHandle = {
	/**
	 * Join `worker` to the shared queue. Returns false (nothing started) when the queue is already
	 * drained, the run was stopped or it has ended: the caller still owns the worker and must release it.
	 */
	addWorker: (worker: BatchWorker) => boolean;
	/** jobs not yet pulled by any worker: 0 once a late worker would have nothing to do */
	pending: () => number;
};

export type RunBatchOptions = {
	workers: readonly BatchWorker[];
	jobs: readonly string[];
	/** extra attempts per failed job, re-run on the same worker */
	retry: number;
	/** run one attempt → exit code (a throw counts as exit 1) */
	run: (worker: BatchWorker, job: string, seq: number, attempt: number) => Promise<number>;
	now: () => number;
	onEvent?: (event: BatchEvent) => void;
	/** aborted → workers finish their current job and stop pulling */
	signal?: AbortSignal;
	/** called once, synchronously, before the initial workers start */
	onStart?: (handle: BatchHandle) => void;
};

/**
 * Fan `jobs` out over `workers`: a shared FIFO queue, each worker pulls the next job when it is free;
 * a failed job is retried (up to `retry` times) on the same worker before it pulls anything new.
 */
export async function runBatch(opts: RunBatchOptions): Promise<BatchSummary> {
	const queue = [...opts.jobs];
	const results: JobResult[] = [];
	const failed: string[] = [];
	const emit = (event: BatchEvent) => opts.onEvent?.(event);
	const stopped = () => opts.signal?.aborted === true;

	/** one attempt → whether to retry it; a job whose last attempt failed lands in `failed` */
	const attempt = async (w: BatchWorker, run: JobRun): Promise<boolean> => {
		const startedAt = opts.now();
		emit({ type: "job-start", at: startedAt, ...run });
		let exitCode: number;
		try {
			exitCode = await opts.run(w, run.job, run.seq, run.attempt);
		} catch {
			exitCode = 1;
		}
		const willRetry = exitCode !== 0 && run.attempt < opts.retry && !stopped();
		const result: JobResult = { ...run, startedAt, endedAt: opts.now(), exitCode };
		results.push(result);
		emit({ type: "job-end", willRetry, ...result });
		if (exitCode !== 0 && !willRetry) failed.push(run.job);
		return willRetry;
	};

	const work = async (w: BatchWorker) => {
		let seq = 0;
		while (!stopped()) {
			const job = queue.shift();
			if (job === undefined) break;
			let n = 0;
			while (await attempt(w, { job, worker: w.worker, udid: w.udid, seq: seq++, attempt: n++ }));
		}
		emit({ type: "worker-idle", worker: w.worker, udid: w.udid, at: opts.now() });
	};

	const active = new Set<Promise<void>>();
	const start = (w: BatchWorker) => {
		const p: Promise<void> = work(w).finally(() => active.delete(p));
		active.add(p);
	};
	let ended = false;
	opts.onStart?.({
		pending: () => queue.length,
		addWorker: (w) => {
			if (ended || stopped() || queue.length === 0) return false;
			emit({ type: "worker-join", worker: w.worker, udid: w.udid, at: opts.now() });
			start(w);
			return true;
		},
	});
	for (const w of opts.workers) start(w);
	while (active.size > 0) await Promise.all([...active]);
	ended = true;
	const ok = failed.length === 0 && !stopped();
	emit({ type: "done", ok, stopped: stopped(), at: opts.now() });
	return { ok, results, failed, stopped: stopped() };
}
