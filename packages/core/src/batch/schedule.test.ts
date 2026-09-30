import { describe, expect, test } from "bun:test";
import { type BatchEvent, type BatchWorker, runBatch } from "./schedule";

const WORKERS: BatchWorker[] = [
	{ worker: 0, udid: "U0" },
	{ worker: 1, udid: "U1" },
];

/** Deferred job runs: each call waits until the test settles it with an exit code. */
function manual() {
	const pending: Array<{ worker: number; job: string; seq: number; attempt: number; settle: (code: number) => void }> =
		[];
	const run = (w: BatchWorker, job: string, seq: number, attempt: number) =>
		new Promise<number>((resolve) => {
			pending.push({ worker: w.worker, job, seq, attempt, settle: resolve });
		});
	const take = (job: string) => {
		const i = pending.findIndex((p) => p.job === job);
		const [hit] = pending.splice(i, 1);
		if (!hit) throw new Error(`no pending ${job}`);
		return hit;
	};
	return { pending, run, take };
}

const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("runBatch", () => {
	test("each free worker pulls the next job from a shared queue; seq is per worker", async () => {
		const m = manual();
		let clock = 100;
		const events: BatchEvent[] = [];
		const done = runBatch({
			workers: WORKERS,
			jobs: ["a", "b", "c", "d"],
			retry: 0,
			run: m.run,
			now: () => clock,
			onEvent: (e) => events.push(e),
		});
		await flush();
		expect(m.pending.map((p) => [p.worker, p.job, p.seq])).toEqual([
			[0, "a", 0],
			[1, "b", 0],
		]);
		clock = 200;
		m.take("b").settle(0);
		await flush();
		expect(m.pending.map((p) => [p.worker, p.job, p.seq])).toEqual([
			[0, "a", 0],
			[1, "c", 1],
		]);
		m.take("c").settle(0);
		await flush();
		expect(m.pending.map((p) => [p.worker, p.job, p.seq])).toEqual([
			[0, "a", 0],
			[1, "d", 2],
		]);
		m.take("a").settle(0);
		await flush();
		expect(events.filter((e) => e.type === "worker-idle").map((e) => e.worker)).toEqual([0]);
		m.take("d").settle(0);
		const summary = await done;
		expect(summary.ok).toBe(true);
		expect(summary.results.map((r) => [r.job, r.worker, r.seq, r.exitCode])).toEqual([
			["b", 1, 0, 0],
			["c", 1, 1, 0],
			["a", 0, 0, 0],
			["d", 1, 2, 0],
		]);
		expect(summary.results[0]).toMatchObject({ udid: "U1", attempt: 0, startedAt: 100, endedAt: 200 });
		expect(events.at(-1)).toMatchObject({ type: "done", ok: true });
		expect(events.filter((e) => e.type === "worker-idle").map((e) => e.worker)).toEqual([0, 1]);
	});

	test("a failed job is retried on the same worker, before new jobs", async () => {
		const m = manual();
		const events: BatchEvent[] = [];
		const done = runBatch({
			workers: WORKERS,
			jobs: ["a", "b", "c"],
			retry: 1,
			run: m.run,
			now: () => 0,
			onEvent: (e) => events.push(e),
		});
		await flush();
		m.take("a").settle(1);
		await flush();
		expect(m.pending.map((p) => [p.worker, p.job, p.seq, p.attempt])).toEqual([
			[1, "b", 0, 0],
			[0, "a", 1, 1],
		]);
		const end = events.find((e) => e.type === "job-end");
		expect(end).toMatchObject({ job: "a", exitCode: 1, willRetry: true });
		m.take("a").settle(0);
		m.take("b").settle(0);
		await flush();
		m.take("c").settle(0);
		const summary = await done;
		expect(summary.ok).toBe(true);
		expect(summary.results.filter((r) => r.job === "a").map((r) => r.attempt)).toEqual([0, 1]);
	});

	test("retries exhausted → ok false, other jobs still run", async () => {
		const summary = await runBatch({
			workers: WORKERS,
			jobs: ["bad", "good", "also"],
			retry: 2,
			run: async (_w, job) => (job === "bad" ? 3 : 0),
			now: () => 0,
		});
		expect(summary.ok).toBe(false);
		expect(summary.results.filter((r) => r.job === "bad").map((r) => r.attempt)).toEqual([0, 1, 2]);
		expect(new Set(summary.results.filter((r) => r.job === "bad").map((r) => r.worker)).size).toBe(1);
		expect(summary.results.filter((r) => r.exitCode === 0).map((r) => r.job)).toEqual(["good", "also"]);
		expect(summary.failed).toEqual(["bad"]);
	});

	test("a thrown run counts as a failure (exit 1)", async () => {
		const summary = await runBatch({
			workers: WORKERS.slice(0, 1),
			jobs: ["x"],
			retry: 0,
			run: async () => {
				throw new Error("boom");
			},
			now: () => 0,
		});
		expect(summary.ok).toBe(false);
		expect(summary.results[0]?.exitCode).toBe(1);
	});

	test("uneven job lengths: a fast worker drains the queue", async () => {
		const order: string[] = [];
		const summary = await runBatch({
			workers: WORKERS,
			jobs: ["slow", "f1", "f2", "f3"],
			retry: 0,
			run: async (w, job) => {
				await Bun.sleep(job === "slow" ? 30 : 1);
				order.push(`${w.worker}:${job}`);
				return 0;
			},
			now: () => 0,
		});
		expect(summary.ok).toBe(true);
		expect(order).toEqual(["1:f1", "1:f2", "1:f3", "0:slow"]);
	});

	test("no jobs → done immediately, ok, every worker idle", async () => {
		const events: BatchEvent[] = [];
		const summary = await runBatch({
			workers: WORKERS,
			jobs: [],
			retry: 0,
			run: async () => 0,
			now: () => 5,
			onEvent: (e) => events.push(e),
		});
		expect(summary).toEqual({ ok: true, results: [], failed: [], stopped: false });
		expect(events.map((e) => e.type)).toEqual(["worker-idle", "worker-idle", "done"]);
	});

	test("abort: running jobs finish, no new jobs start, ok false", async () => {
		const m = manual();
		const controller = new AbortController();
		const done = runBatch({
			workers: WORKERS,
			jobs: ["a", "b", "c", "d"],
			retry: 0,
			run: m.run,
			now: () => 0,
			signal: controller.signal,
		});
		await flush();
		controller.abort();
		m.take("a").settle(0);
		m.take("b").settle(0);
		const summary = await done;
		expect(summary.results.map((r) => r.job)).toEqual(["a", "b"]);
		expect(summary.stopped).toBe(true);
		expect(summary.ok).toBe(false);
	});
});
