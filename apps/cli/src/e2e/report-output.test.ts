import { describe, expect, test } from "bun:test";
import type { TestResult } from "@delacour/warden-e2e/runner/results";
import type { E2eReport } from "../commands/e2e";
import {
	annotations,
	commonFailure,
	githubTarget,
	specLine,
	stepSummary,
	testEvent,
	testTotals,
} from "./report-output";
import type { SpecVerdict } from "./verdicts";

const ROOT = "/w/app";
const STACK = [
	"E2eError: snapshot failed: no frontmost application",
	"    at <anonymous> (/w/app/node_modules/@delacour/warden-e2e/chunk.mjs:1760:30)",
	"    at freshLaunch (/w/app/e2e/helpers/auth.ts:40:15)",
	"    at <anonymous> (/w/app/e2e/m1/a01-sign-in.e2e.ts:22:11)",
].join("\n");

const spec = (over: Partial<SpecVerdict> & Pick<SpecVerdict, "id">): SpecVerdict => ({
	file: `${ROOT}/e2e/m1/${over.id}.e2e.ts`,
	required: true,
	reasons: [],
	verdict: "passed",
	attempts: 1,
	...over,
});

const report = (specs: SpecVerdict[], ok = false): E2eReport => ({
	suite: "mobile",
	platform: "ios",
	isolate: "device",
	ok,
	headless: true,
	batchDir: "/h/batches/b1",
	specs,
});

const failed = report([
	spec({
		id: "a01-sign-in",
		verdict: "failed",
		log: "/h/batches/b1/logs/0-0.log",
		tests: [
			{ title: ["M1-A1: signs in"], status: "failed", durationMs: 24_800, error: "snapshot failed: x\nmore", line: 22 },
			{ title: ["M1-A1: opens"], status: "passed", durationMs: 1_000 },
		],
	}),
	spec({
		id: "a02-code-errors",
		verdict: "failed",
		tests: [
			{ title: ["M1-A2", "a | b"], status: "timed-out", durationMs: 30_000, error: "snapshot failed: x" },
			{ title: ["M1-A2: skipped"], status: "skipped", durationMs: 0 },
		],
	}),
	spec({ id: "a03-crash", verdict: "failed", required: false, log: "/h/batches/b1/logs/0-1.log" }),
	spec({ id: "a04-ok", tests: [{ title: ["fine"], status: "passed", durationMs: 500 }] }),
]);

describe("specLine", () => {
	test("the first frame in the spec file, past helpers and warden's own frames", () => {
		expect(specLine(STACK, "/w/app/e2e/m1/a01-sign-in.e2e.ts")).toBe(22);
	});
	test("undefined when the spec file is not on the stack, or there is no stack", () => {
		expect(specLine(STACK, "/w/app/e2e/m1/other.e2e.ts")).toBeUndefined();
		expect(specLine(undefined, "/w/app/e2e/m1/a01-sign-in.e2e.ts")).toBeUndefined();
	});
});

describe("testTotals / commonFailure", () => {
	test("counts tests by outcome (timed-out is failed) and specs with no tests by verdict", () => {
		expect(testTotals(failed)).toEqual({ passed: 2, failed: 2, skipped: 1, specsPassed: 1, specs: 4 });
	});
	test("the first error line most failed tests share, once two or more share it", () => {
		expect(commonFailure(failed)).toEqual({ message: "snapshot failed: x", count: 2, of: 2 });
		expect(commonFailure(report([spec({ id: "a", verdict: "failed", tests: [] })]))).toBeUndefined();
	});
});

describe("githubTarget", () => {
	test("only under GitHub Actions; the summary file when the runner gives one", () => {
		expect(githubTarget({})).toBeUndefined();
		expect(githubTarget({ GITHUB_ACTIONS: "false" })).toBeUndefined();
		expect(githubTarget({ GITHUB_ACTIONS: "true", GITHUB_WORKSPACE: "/w", GITHUB_STEP_SUMMARY: "/s.md" })).toEqual({
			root: "/w",
			summary: "/s.md",
		});
	});
});

describe("annotations", () => {
	test("one ::error per failed test at its spec line, path relative to the workspace, data escaped", () => {
		const lines = annotations(failed, ROOT);
		expect(lines[0]).toBe(
			"::error file=e2e/m1/a01-sign-in.e2e.ts,line=22,title=a01-sign-in › M1-A1%3A signs in::snapshot failed: x%0Amore"
		);
		expect(lines[1]).toBe(
			"::error file=e2e/m1/a02-code-errors.e2e.ts,title=a02-code-errors › M1-A2 › a | b::snapshot failed: x"
		);
	});
	test("a failed spec with no test results is annotated on the file; an optional one is a warning", () => {
		expect(annotations(failed, ROOT)[2]).toBe(
			"::warning file=e2e/m1/a03-crash.e2e.ts,title=a03-crash failed (optional)::no test results — log /h/batches/b1/logs/0-1.log"
		);
	});
	test("nothing for a passing run", () => {
		expect(annotations(report([spec({ id: "a04-ok" })], true), ROOT)).toEqual([]);
	});
});

describe("stepSummary", () => {
	test("heading with the gate, totals, the shared failure, then one row per failed test, pipes escaped", () => {
		const md = stepSummary(failed);
		expect(md).toContain("### ❌ warden e2e `mobile` (ios): gate failed");
		expect(md).toContain("1/4 spec(s) passed · tests: 2 passed, 2 failed, 1 skipped");
		expect(md).toContain("2/2 failed tests share: `snapshot failed: x`");
		expect(md).toContain("| ❌ | a01-sign-in | M1-A1: signs in | 24.8s | snapshot failed: x |");
		expect(md).toContain("| ⏱️ | a02-code-errors | M1-A2 › a \\| b | 30.0s | snapshot failed: x |");
		expect(md).toContain("| ⚠️ | a03-crash (optional) | (no test results) | | log `/h/batches/b1/logs/0-1.log` |");
		expect(md).not.toContain("a04-ok |");
		expect(md).toContain("Batch dir: `/h/batches/b1`");
	});
	test("a passing run is one line", () => {
		expect(stepSummary(report([spec({ id: "a04-ok" })], true))).toContain(
			"### ✅ warden e2e `mobile` (ios): gate passed"
		);
	});
});

describe("testEvent", () => {
	test("one finished test as an NDJSON event, with its spec line", () => {
		const result: TestResult = {
			file: "/w/app/e2e/m1/a01-sign-in.e2e.ts",
			title: ["M1-A1: signs in"],
			status: "failed",
			durationMs: 24_800,
			startedAt: 1,
			error: { message: "snapshot failed: x", code: "DRIVER", stack: STACK },
			artifacts: { dir: "/h/a", files: ["failure.png"] },
			device: { udid: "U1", platform: "ios", name: "warden-iphone-17-1" },
		};
		expect(testEvent("a01-sign-in", result)).toEqual({
			event: "test",
			spec: "a01-sign-in",
			file: "/w/app/e2e/m1/a01-sign-in.e2e.ts",
			title: ["M1-A1: signs in"],
			status: "failed",
			durationMs: 24_800,
			error: "snapshot failed: x",
			code: "DRIVER",
			line: 22,
			artifacts: "/h/a",
			device: { udid: "U1", name: "warden-iphone-17-1" },
		});
	});
});
