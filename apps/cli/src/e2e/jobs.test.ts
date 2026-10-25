import { describe, expect, test } from "bun:test";
import type { SelectedSpec } from "@delacour/warden-core/affected/select";
import type { TestResult } from "@delacour/warden-e2e/runner/results";
import { jsonl, result } from "../batch/results.testing";
import { attemptOut, jobPlan, shardRuns } from "./jobs";

const spec = (id: string): SelectedSpec => ({ id, file: `/specs/${id}.e2e.ts`, required: true, reasons: [] });
const argvOf = (files: readonly string[]) => ["bun", "test", ...files];
const file = (id: string) => `/specs/${id}.e2e.ts`;

describe("jobPlan", () => {
	const specs = ["d", "a", "c", "b", "e"].map(spec);

	test("spec isolation: one job per spec, each with its own bun test", () => {
		const plan = jobPlan(specs, undefined, argvOf);
		expect(plan.jobs).toEqual(["d", "a", "c", "b", "e"]);
		expect(plan.argvs.get("c")).toEqual(["bun", "test", file("c")]);
		expect(plan.shardOf).toBeUndefined();
		expect(plan.shards).toBeUndefined();
	});

	test("device isolation: one shard job per device, specs round-robin by sorted id", () => {
		const plan = jobPlan(specs, 2, argvOf);
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

	test("one device runs every spec in one process; shards never outnumber specs", () => {
		expect(jobPlan(specs, 1, argvOf).jobs).toEqual(["shard-0"]);
		expect(jobPlan(specs, 1, argvOf).argvs.get("shard-0")).toEqual([
			"bun",
			"test",
			...["a", "b", "c", "d", "e"].map(file),
		]);
		expect(jobPlan(specs, 9, argvOf).jobs).toHaveLength(5);
		expect(jobPlan(specs, 0, argvOf).jobs).toEqual(["shard-0"]);
	});

	test("the same specs land together whatever order they were selected in", () => {
		const shuffled = [...specs].reverse();
		expect(jobPlan(shuffled, 2, argvOf).argvs).toEqual(jobPlan(specs, 2, argvOf).argvs);
	});

	test("no specs, no jobs", () => {
		expect(jobPlan([], 3, argvOf).jobs).toEqual([]);
		expect(jobPlan([], undefined, argvOf).jobs).toEqual([]);
	});
});

const res = (id: string, title: string, status: TestResult["status"] = "passed") => result(file(id), title, status);

/** shard runs over `a b c d` as one shard, with the results each attempt's directory holds */
function shard(files: Record<string, TestResult[]> = {}) {
	const plan = jobPlan(["a", "b", "c", "d"].map(spec), 1, argvOf);
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

const tests = (argv: string[]) => argv.slice(2).map((f) => f.replace("/specs/", "").replace(".e2e.ts", ""));

describe("shardRuns: retries run only the specs that did not pass", () => {
	test("the first attempt runs the whole shard and no results are read", async () => {
		const s = shard();
		expect(tests(await s.runs.argv(s.run(0, 0, 0)))).toEqual(["a", "b", "c", "d"]);
		expect(s.reads).toEqual([]);
		expect([...(s.runs.attempts.get("0:0") ?? [])]).toEqual(["a", "b", "c", "d"]);
	});

	test("a retry runs only the specs with a failed test", async () => {
		const s = shard({
			[attemptOut("/batch", 0, 0)]: [res("a", "t"), res("b", "t", "failed"), res("c", "t"), res("d", "t")],
		});
		await s.runs.argv(s.run(0, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["b"]);
		expect(s.reads).toEqual([`${s.out(0, 0)}/results.jsonl`]);
		expect([...(s.runs.attempts.get("0:1") ?? [])]).toEqual(["b"]);
		expect([...(s.runs.attempts.get("0:0") ?? [])]).toEqual(["a", "b", "c", "d"]);
	});

	test("after a crash the retry runs the spec that was running and every spec that never started", async () => {
		const s = shard({ [attemptOut("/batch", 0, 0)]: [res("a", "t"), res("b", "t"), res("c", "first")] });
		await s.runs.argv(s.run(0, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["c", "d"]);
	});

	test("each retry narrows the previous attempt's specs, not the whole shard", async () => {
		const s = shard({
			[attemptOut("/batch", 0, 0)]: [res("a", "t"), res("b", "t", "failed"), res("c", "t", "failed"), res("d", "t")],
			[attemptOut("/batch", 0, 1)]: [res("b", "t"), res("c", "t", "failed")],
		});
		await s.runs.argv(s.run(0, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["b", "c"]);
		expect(tests(await s.runs.argv(s.run(0, 2, 2)))).toEqual(["c"]);
	});

	test("seq counts every run on the worker: the retry reads the attempt it follows", async () => {
		const s = shard({
			[attemptOut("/batch", 0, 3)]: [res("a", "t"), res("b", "t", "failed"), res("c", "t"), res("d", "t")],
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
			[attemptOut("/batch", 0, 0)]: ["a", "b", "c", "d"].map((id) => res(id, "t")),
		});
		await s.runs.argv(s.run(0, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["a", "b", "c", "d"]);
	});

	test("the same attempt asked again (per pass) gets the same argv without reading anything", async () => {
		const s = shard({ [attemptOut("/batch", 0, 0)]: [res("a", "t"), res("b", "t", "failed")] });
		await s.runs.argv(s.run(0, 0, 0));
		const first = await s.runs.argv(s.run(0, 1, 1));
		expect(await s.runs.argv(s.run(0, 1, 1))).toEqual(first);
		expect(s.reads).toHaveLength(1);
	});

	test("two workers running the same shard job (device legs) retry on their own", async () => {
		const s = shard({
			[attemptOut("/batch", 0, 0)]: [res("a", "t", "failed"), res("b", "t"), res("c", "t"), res("d", "t")],
			[attemptOut("/batch", 1, 0)]: [res("a", "t"), res("b", "t"), res("c", "t"), res("d", "t", "failed")],
		});
		await s.runs.argv(s.run(0, 0, 0));
		await s.runs.argv(s.run(1, 0, 0));
		expect(tests(await s.runs.argv(s.run(0, 1, 1)))).toEqual(["a"]);
		expect(tests(await s.runs.argv(s.run(1, 1, 1)))).toEqual(["d"]);
	});

	test("a spec-isolated job is just its own argv", async () => {
		const plan = jobPlan(["a", "b"].map(spec), undefined, argvOf);
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

	test("a later pass of the same attempt gets its own directory (12-10)", () => {
		expect(attemptOut("/batch", 2, 5, 0)).toBe("/batch/e2e/2-5");
		expect(attemptOut("/batch", 2, 5, 1)).toBe("/batch/e2e/2-5-p1");
	});
});
