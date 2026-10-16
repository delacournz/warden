import { describe, expect, test } from "bun:test";
import type { SelectedFlow } from "@delacour/warden-core/affected/select";
import type { TestResult } from "@delacour/warden-e2e/runner/results";
import { jsonl, result } from "../batch/results.testing";
import { attemptOut, jobPlan, shardRuns } from "./jobs";

const flow = (id: string): SelectedFlow => ({ id, file: `/flows/${id}.e2e.ts`, required: true, reasons: [] });
const argvOf = (files: readonly string[]) => ["bun", "test", ...files];
const file = (id: string) => `/flows/${id}.e2e.ts`;

describe("jobPlan", () => {
	const flows = ["d", "a", "c", "b", "e"].map(flow);

	test("flow isolation: one job per flow, each with its own bun test", () => {
		const plan = jobPlan(flows, undefined, argvOf);
		expect(plan.jobs).toEqual(["d", "a", "c", "b", "e"]);
		expect(plan.argvs.get("c")).toEqual(["bun", "test", file("c")]);
		expect(plan.shardOf).toBeUndefined();
		expect(plan.shards).toBeUndefined();
	});

	test("device isolation: one shard job per device, flows round-robin by sorted id", () => {
		const plan = jobPlan(flows, 2, argvOf);
		expect(plan.jobs).toEqual(["shard-0", "shard-1"]);
		expect(plan.argvs.get("shard-0")).toEqual(["bun", "test", file("a"), file("c"), file("e")]);
		expect(plan.argvs.get("shard-1")).toEqual(["bun", "test", file("b"), file("d")]);
		expect(Object.fromEntries(plan.shardOf ?? [])).toEqual({
			a: "shard-0",
			b: "shard-1",
			c: "shard-0",
			d: "shard-1",
			e: "shard-0",
		});
		expect(plan.shards?.get("shard-1")?.map((f) => f.id)).toEqual(["b", "d"]);
	});

	test("one device runs every flow in one process; shards never outnumber flows", () => {
		expect(jobPlan(flows, 1, argvOf).jobs).toEqual(["shard-0"]);
		expect(jobPlan(flows, 1, argvOf).argvs.get("shard-0")).toEqual([
			"bun",
			"test",
			...["a", "b", "c", "d", "e"].map(file),
		]);
		expect(jobPlan(flows, 9, argvOf).jobs).toHaveLength(5);
		expect(jobPlan(flows, 0, argvOf).jobs).toEqual(["shard-0"]);
	});

	test("the same flows land together whatever order they were selected in", () => {
		const shuffled = [...flows].reverse();
		expect(jobPlan(shuffled, 2, argvOf).argvs).toEqual(jobPlan(flows, 2, argvOf).argvs);
	});

	test("no flows, no jobs", () => {
		expect(jobPlan([], 3, argvOf).jobs).toEqual([]);
		expect(jobPlan([], undefined, argvOf).jobs).toEqual([]);
	});
});

const spec = (id: string, title: string, status: TestResult["status"] = "passed") => result(file(id), title, status);

/** shard runs over `a b c d` as one shard, with the results each attempt's directory holds */
function shard(files: Record<string, TestResult[]> = {}) {
	const plan = jobPlan(["a", "b", "c", "d"].map(flow), 1, argvOf);
	const reads: string[] = [];
	const store = new Map(Object.entries(files).map(([dir, results]) => [`${dir}/results.jsonl`, jsonl(...results)]));
	const runs = shardRuns(plan, {
		argvOf,
		readFile: async (path) => {
			reads.push(path);
			const text = store.get(path);
			if (text === undefined) throw new Error("ENOENT");
			return text;
		},
		real: (path) => path,
	});
	const run = (worker: number, seq: number, attempt: number, job = "shard-0") => ({
		job,
		worker,
		seq,
		attempt,
		batchDir: "/batch",
	});
	const out = (worker: number, seq: number) => attemptOut("/batch", worker, seq);
	return { runs, reads, run, out, store };
}

const tests = (argv: string[]) => argv.slice(2).map((f) => f.replace("/flows/", "").replace(".e2e.ts", ""));

describe("shardRuns: retries run only the flows that did not pass", () => {
	test("the first attempt runs the whole shard and no results are read", async () => {
		const s = shard();
		expect(tests(await s.runs.argv(s.run(0, 0, 0)))).toEqual(["a", "b", "c", "d"]);
		expect(s.reads).toEqual([]);
		expect([...(s.runs.attempts.get("0:0") ?? [])]).toEqual(["a", "b", "c", "d"]);
	});

	test("a retry runs only the flows with a failed test", async () => {
		const s = shard({
			[attemptOut("/batch", 0, 0)]: [spec("a", "t"), spec("b", "t", "failed"), spec("c", "t"), spec("d", "t")],
		});
		await s.runs.argv(s.run(0, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["b"]);
		expect(s.reads).toEqual([`${s.out(0, 0)}/results.jsonl`]);
		expect([...(s.runs.attempts.get("0:1") ?? [])]).toEqual(["b"]);
		expect([...(s.runs.attempts.get("0:0") ?? [])]).toEqual(["a", "b", "c", "d"]);
	});

	test("after a crash the retry runs the flow that was running and every flow that never started", async () => {
		const s = shard({ [attemptOut("/batch", 0, 0)]: [spec("a", "t"), spec("b", "t"), spec("c", "first")] });
		await s.runs.argv(s.run(0, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["c", "d"]);
	});

	test("each retry narrows the previous attempt's flows, not the whole shard", async () => {
		const s = shard({
			[attemptOut("/batch", 0, 0)]: [
				spec("a", "t"),
				spec("b", "t", "failed"),
				spec("c", "t", "failed"),
				spec("d", "t"),
			],
			[attemptOut("/batch", 0, 1)]: [spec("b", "t"), spec("c", "t", "failed")],
		});
		await s.runs.argv(s.run(0, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["b", "c"]);
		expect(tests(await s.runs.argv(s.run(0, 2, 2)))).toEqual(["c"]);
	});

	test("seq counts every run on the worker: the retry reads the attempt it follows", async () => {
		const s = shard({
			[attemptOut("/batch", 0, 3)]: [spec("a", "t"), spec("b", "t", "failed"), spec("c", "t"), spec("d", "t")],
		});
		await s.runs.argv(s.run(0, 3, 0));
		expect(tests(await s.runs.argv(s.run(0, 4, 1)))).toEqual(["b"]);
		expect(s.reads).toEqual([`${s.out(0, 3)}/results.jsonl`]);
	});

	test("no results.jsonl: the retry runs everything the last attempt did", async () => {
		const s = shard();
		await s.runs.argv(s.run(0, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["a", "b", "c", "d"]);
	});

	test("a failure nobody can be blamed for (every test passed, the process failed) reruns the lot", async () => {
		const s = shard({
			[attemptOut("/batch", 0, 0)]: ["a", "b", "c", "d"].map((id) => spec(id, "t")),
		});
		await s.runs.argv(s.run(0, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["a", "b", "c", "d"]);
	});

	test("the same attempt asked again (per pass) gets the same argv without reading anything", async () => {
		const s = shard({ [attemptOut("/batch", 0, 0)]: [spec("a", "t"), spec("b", "t", "failed")] });
		await s.runs.argv(s.run(0, 0, 0));
		const first = await s.runs.argv(s.run(0, 1, 1));
		expect(await s.runs.argv(s.run(0, 1, 1))).toEqual(first);
		expect(s.reads).toHaveLength(1);
	});

	test("two workers running the same shard job (device legs) retry on their own", async () => {
		const s = shard({
			[attemptOut("/batch", 0, 0)]: [spec("a", "t", "failed"), spec("b", "t"), spec("c", "t"), spec("d", "t")],
			[attemptOut("/batch", 1, 0)]: [spec("a", "t"), spec("b", "t"), spec("c", "t"), spec("d", "t", "failed")],
		});
		await s.runs.argv(s.run(0, 0, 0));
		await s.runs.argv(s.run(1, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["a"]);
		expect(tests(await s.runs.argv(s.run(1, 1, 1)))).toEqual(["d"]);
	});

	test("a flow-isolated job is just its own argv", async () => {
		const plan = jobPlan(["a", "b"].map(flow), undefined, argvOf);
		const runs = shardRuns(plan, {
			argvOf,
			readFile: async () => {
				throw new Error("never read");
			},
			real: (path) => path,
		});
		const run = { job: "b", worker: 0, seq: 0, attempt: 1, batchDir: "/batch" };
		expect(await runs.argv(run)).toEqual(["bun", "test", file("b")]);
		expect(runs.attempts.size).toBe(0);
	});
});

describe("attemptOut", () => {
	test("one directory per attempt under the batch dir", () => {
		expect(attemptOut("/batch", 2, 5)).toBe("/batch/e2e/2-5");
	});
});
