import { describe, expect, test } from "bun:test";
import type { SelectedSpec } from "@delacour/warden-core/affected/select";
import type { JobResult } from "@delacour/warden-core/batch/schedule";
import type { TestResult } from "@delacour/warden-e2e/runner/results";
import { jsonl, result } from "../batch/results.testing";
import type { SessionResult } from "../commands/batch";
import { judgeJob, type RunShape, verdicts } from "./verdicts";

const real = (path: string) => path;
const spec = (id: string, required = true): SelectedSpec => ({
	id,
	file: `/specs/${id}.e2e.ts`,
	required,
	reasons: [],
});
const res = (id: string, title: string, status: TestResult["status"] = "passed") =>
	result(`/specs/${id}.e2e.ts`, title, status);

const [A, B, C] = [spec("a"), spec("b"), spec("c")];
const verdictsOf = (judged: ReturnType<typeof judgeJob>) =>
	Object.fromEntries([...judged].map(([id, j]) => [id, j.verdict]));

describe("judgeJob (one spec process over its specs)", () => {
	test("exit 0: a failed test fails its spec, the rest pass", () => {
		const all = [res("a", "t"), res("b", "t", "failed"), res("c", "t")];
		expect(verdictsOf(judgeJob([A, B, C], all, 0, real))).toEqual({ a: "passed", b: "failed", c: "passed" });
	});

	test("a non-zero exit with a failed test elsewhere blames that test, not the specs that passed", () => {
		const all = [res("a", "t"), res("b", "t", "failed"), res("c", "t")];
		expect(verdictsOf(judgeJob([A, B, C], all, 1, real))).toEqual({ a: "passed", b: "failed", c: "passed" });
	});

	test("a non-zero exit nobody can be blamed for, every spec finished: all of them fail", () => {
		const all = [res("a", "t"), res("b", "t")];
		expect(verdictsOf(judgeJob([A, B], all, 1, real))).toEqual({ a: "failed", b: "failed" });
	});

	test("a failed spec does not drag down the spec that ran last, nor a skipped spec before it", () => {
		const skipped = spec("skipped");
		const all = [res("a", "t"), res("b", "t", "failed"), res("c", "t")];
		expect(verdictsOf(judgeJob([skipped, A, B, C], all, 1, real))).toEqual({
			skipped: "passed",
			a: "passed",
			b: "failed",
			c: "passed",
		});
	});

	test("a crash: the spec running when the process died and every spec after it fail, those before it pass", () => {
		const all = [res("a", "t"), res("b", "first test")];
		expect(verdictsOf(judgeJob([A, B, C], all, 1, real))).toEqual({ a: "passed", b: "failed", c: "failed" });
	});

	test("a crash after a failed test: that spec stays failed, the one running at the crash fails too", () => {
		const all = [res("a", "t"), res("b", "t", "failed"), res("c", "first test")];
		const d = spec("d");
		expect(verdictsOf(judgeJob([A, B, C, d], all, 137, real))).toEqual({
			a: "passed",
			b: "failed",
			c: "failed",
			d: "failed",
		});
	});

	test("a spec with no result of its own passes on exit 0 (a spec with no tests) and fails on a non-zero exit", () => {
		const all = [res("a", "t"), res("c", "t")];
		expect(verdictsOf(judgeJob([A, B, C], all, 0, real))).toEqual({ a: "passed", b: "passed", c: "passed" });
		expect(verdictsOf(judgeJob([A, B, C], [res("a", "t"), res("b", "t"), res("c", "t", "failed")], 1, real))).toEqual({
			a: "passed",
			b: "passed",
			c: "failed",
		});
		expect(verdictsOf(judgeJob([A, B, C], all, 1, real))).toEqual({ a: "passed", b: "failed", c: "failed" });
	});

	test("no usable results.jsonl: the exit code decides every spec, and the verdict says so", () => {
		for (const results of [undefined, []]) {
			const ok = judgeJob([A, B], results, 0, real);
			const bad = judgeJob([A, B], results, 1, real);
			expect(verdictsOf(ok)).toEqual({ a: "passed", b: "passed" });
			expect(verdictsOf(bad)).toEqual({ a: "failed", b: "failed" });
			expect([...bad.values()].every((j) => j.fellBack)).toBe(true);
		}
	});

	test("results of files that are not this job's specs are ignored", () => {
		const all = [res("other", "t", "failed"), res("a", "t")];
		expect(verdictsOf(judgeJob([A], all, 0, real))).toEqual({ a: "passed" });
	});

	test("a spec carries its own tests", () => {
		const all = [res("a", "one"), res("a", "two", "failed")];
		const judged = judgeJob([A], all, 1, real).get("a");
		expect(judged?.tests?.map((t) => [t.title, t.status])).toEqual([
			[["one"], "passed"],
			[["two"], "failed"],
		]);
	});
});

const jobResult = (job: string, worker: number, seq: number, attempt: number, exitCode: number): JobResult => ({
	job,
	worker,
	udid: `U${worker}`,
	seq,
	attempt,
	exitCode,
	startedAt: 0,
	endedAt: 1,
});

/** A finished run of the `shard-0` job: one entry per attempt, each with the `results.jsonl` it wrote. */
function session(
	attempts: Array<{ exitCode: number; results?: TestResult[] }>,
	job = "shard-0"
): {
	session: SessionResult;
	files: Map<string, string>;
} {
	const files = new Map<string, string>();
	const resultFiles = new Map<string, string>();
	const logs = new Map<string, string>();
	const results = attempts.map((a, i) => {
		const path = `/out/0-${i}/results.jsonl`;
		if (a.results) files.set(path, jsonl(...a.results));
		resultFiles.set(`0:${i}`, path);
		logs.set(`0:${i}`, `/logs/0-${i}-${job}.log`);
		return jobResult(job, 0, i, i, a.exitCode);
	});
	const failed = attempts.at(-1)?.exitCode === 0 ? [] : [job];
	return {
		session: {
			code: failed.length === 0 ? 0 : 1,
			summary: { ok: failed.length === 0, stopped: false, results, failed },
			resultFiles,
			logs,
			devices: [{ worker: 0, udid: "U0", name: "iPhone" }],
		},
		files,
	};
}

const shape: RunShape = {
	legs: [undefined],
	shardOf: new Map([
		["a", "shard-0"],
		["b", "shard-0"],
		["c", "shard-0"],
	]),
};
const io = (files: Map<string, string>, extra: { attempts?: Map<string, Set<string>> } = {}) => ({
	readFile: async (path: string) => {
		const text = files.get(path);
		if (text === undefined) throw new Error("ENOENT");
		return text;
	},
	ci: false,
	real,
	...extra,
});

describe("verdicts over device shards", () => {
	test("a crash fails the spec it hit and the specs it never reached, and says where the process died", async () => {
		const s = session([{ exitCode: 1, results: [res("a", "t"), res("b", "first")] }]);
		const out = await verdicts([A, B, C], s.session, shape, io(s.files));
		expect(out.specs.map((f) => [f.id, f.verdict])).toEqual([
			["a", "passed"],
			["b", "failed"],
			["c", "failed"],
		]);
		expect(out.ok).toBe(false);
		expect(out.specs[0]).not.toHaveProperty("log");
		expect(out.specs[1]?.log).toBe("/logs/0-0-shard-0.log");
		expect(out.specs[2]?.log).toBe("/logs/0-0-shard-0.log");
	});

	test("a retry that ran only the failed specs: each spec's verdict is from the last attempt that ran it", async () => {
		const s = session([
			{ exitCode: 1, results: [res("a", "t"), res("b", "t", "failed"), res("c", "t")] },
			{ exitCode: 0, results: [res("b", "t")] },
		]);
		const attempts = new Map([
			["0:0", new Set(["a", "b", "c"])],
			["0:1", new Set(["b"])],
		]);
		const out = await verdicts([A, B, C], s.session, shape, io(s.files, { attempts }));
		expect(out.specs.map((f) => [f.id, f.verdict, f.attempts])).toEqual([
			["a", "passed", 1],
			["b", "passed", 2],
			["c", "passed", 1],
		]);
		expect(out.ok).toBe(true);
		expect(out.specs[1]?.log).toBe("/logs/0-0-shard-0.log");
	});

	test("a spec that fails again after the retry keeps failing, with the last failure's log", async () => {
		const s = session([
			{ exitCode: 1, results: [res("a", "t"), res("b", "t", "failed")] },
			{ exitCode: 1, results: [res("b", "t", "failed")] },
		]);
		const attempts = new Map([
			["0:0", new Set(["a", "b"])],
			["0:1", new Set(["b"])],
		]);
		const out = await verdicts([A, B], s.session, shape, io(s.files, { attempts }));
		expect(out.specs.map((f) => [f.id, f.verdict, f.attempts])).toEqual([
			["a", "passed", 1],
			["b", "failed", 2],
		]);
		expect(out.specs[1]?.log).toBe("/logs/0-1-shard-0.log");
		expect(out.ok).toBe(false);
	});

	test("without an attempt map every attempt is a whole-shard run, as before: the last one decides", async () => {
		const s = session([
			{ exitCode: 1, results: [res("a", "t", "failed"), res("b", "t")] },
			{ exitCode: 0, results: [res("a", "t"), res("b", "t")] },
		]);
		const out = await verdicts([A, B], s.session, shape, io(s.files));
		expect(out.specs.map((f) => [f.id, f.verdict, f.attempts])).toEqual([
			["a", "passed", 2],
			["b", "passed", 2],
		]);
	});

	test("a shard that never ran its specs: not-run", async () => {
		const out = await verdicts(
			[A, B],
			{ code: 1, summary: { ok: false, stopped: true, results: [], failed: [] } },
			shape,
			io(new Map())
		);
		expect(out.specs.map((f) => f.verdict)).toEqual(["not-run", "not-run"]);
		expect(out.ok).toBe(false);
	});
});

describe("verdicts: the failure screenshot", () => {
	const shot = (dir: string, files = ["failure.png", "screen-at-failure.txt", "trace.jsonl"]) => ({
		artifacts: { dir, files },
	});

	test("a failed test whose attempt dir holds failure.png points the spec at it (no batch shot)", async () => {
		const s = session([
			{
				exitCode: 1,
				results: [res("a", "t"), { ...res("b", "t", "failed"), ...shot("/art/b-1") }, res("c", "t")],
			},
		]);
		const out = await verdicts([A, B, C], s.session, shape, io(s.files));
		const byId = Object.fromEntries(out.specs.map((f) => [f.id, f]));
		expect(byId.b?.verdict).toBe("failed");
		expect(byId.b?.screenshot).toBe("/art/b-1/failure.png");
		expect(byId.a).not.toHaveProperty("screenshot");
		expect(byId.c).not.toHaveProperty("screenshot");
	});

	test("the runner's shot wins over a batch shot of the same attempt (taken after the whole shard ran)", async () => {
		const s = session([{ exitCode: 1, results: [{ ...res("a", "t", "failed"), ...shot("/art/a-1") }] }]);
		const withBatch = { ...s.session, screenshots: new Map([["0:0", "/logs/0-0-shard-0.png"]]) };
		const out = await verdicts([A], withBatch, ONE_SHARD, io(s.files));
		expect(out.specs[0]?.screenshot).toBe("/art/a-1/failure.png");
	});

	test("a failed test without failure.png, or an attempt with no results, keeps the batch shot", async () => {
		const noPng = session([
			{ exitCode: 1, results: [{ ...res("a", "t", "failed"), ...shot("/art/a-1", ["trace.jsonl"]) }] },
		]);
		const crashed = session([{ exitCode: 137 }]);
		for (const s of [noPng, crashed]) {
			const withBatch = { ...s.session, screenshots: new Map([["0:0", "/logs/0-0-shard-0.png"]]) };
			const out = await verdicts([A], withBatch, ONE_SHARD, io(s.files));
			expect(out.specs[0]?.screenshot).toBe("/logs/0-0-shard-0.png");
		}
	});

	test("after a retry the latest failed attempt's runner shot is the one reported", async () => {
		const s = session([
			{ exitCode: 1, results: [{ ...res("a", "t", "failed"), ...shot("/art/a-1") }] },
			{ exitCode: 1, results: [{ ...res("a", "t", "failed"), ...shot("/art/a-2") }] },
		]);
		const out = await verdicts([A], s.session, ONE_SHARD, io(s.files));
		expect(out.specs[0]).toMatchObject({ attempts: 2, screenshot: "/art/a-2/failure.png" });
	});
});

const ONE_SHARD: RunShape = { legs: [undefined], shardOf: new Map([["a", "shard-0"]]) };

describe("perf artifacts and budgets", () => {
	const base = res("a", "t", "failed");

	test("a test with a perf/report.json links its perf dir", () => {
		const t = { ...base, artifacts: { dir: "/o/a/t-1", files: ["perf/report.json", "perf/report.md"] } };
		const tests = judgeJob([A], [t], 1, real).get("a")?.tests;
		expect(tests?.[0]).toMatchObject({ perf: "/o/a/t-1/perf" });
		expect(tests?.[0]?.kind).toBeUndefined();
	});

	test("a PERF_BUDGET failure is a perf_budget test", () => {
		const t = {
			...base,
			error: { message: "perf_budget: 1 metric over budget\n  jankPct: 12 > budget 5", code: "PERF_BUDGET" },
		};
		expect(judgeJob([A], [t], 1, real).get("a")?.tests?.[0]).toMatchObject({ kind: "perf_budget", status: "failed" });
	});

	test("no perf files, no link", () => {
		const t = { ...base, artifacts: { dir: "/o", files: ["trace.jsonl"] } };
		expect(judgeJob([A], [t], 1, real).get("a")?.tests?.[0]?.perf).toBeUndefined();
	});
});
