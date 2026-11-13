import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecOptions, ExecResult } from "./exec";
import {
	formatBuildIssues,
	formatTestFailures,
	prepareResultBundle,
	readBuildIssues,
	readTestFailures,
	resultsDirFor,
} from "./xcresult";

const FIXTURES = join(import.meta.dir, "__fixtures__", "xcresult");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

type Call = { cmd: string[]; opts: ExecOptions | undefined };

function fakeExec(byCommand: Record<string, ExecResult | (() => Promise<ExecResult>)>): { exec: Exec; calls: Call[] } {
	const calls: Call[] = [];
	const exec: Exec = async (cmd, opts) => {
		calls.push({ cmd: [...cmd], opts });
		const key = cmd.slice(2, cmd.indexOf("--path")).join(" ");
		const hit = byCommand[key];
		if (hit === undefined) return { exitCode: 64, stdout: "", stderr: `unknown ${key}` };
		return typeof hit === "function" ? hit() : hit;
	};
	return { exec, calls };
}

const out = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

describe("readBuildIssues", () => {
	test("errors with file and 1-based line, and the warning count", async () => {
		const { exec, calls } = fakeExec({ "get build-results": out(fixture("build-results.failed.json")) });
		const issues = await readBuildIssues("/r/a.xcresult", exec);
		expect(issues).toEqual({
			errors: [
				{
					message: "Cannot convert return expression of type 'String' to return type 'Int'",
					file: "/Users/dev/Demo/Sources/Demo/Demo.swift",
					line: 1,
				},
			],
			warnings: 1,
		});
		expect(calls[0]?.cmd).toEqual([
			"xcrun",
			"xcresulttool",
			"get",
			"build-results",
			"--path",
			"/r/a.xcresult",
			"--compact",
		]);
		expect(calls[0]?.opts?.timeoutMs).toBe(10_000);
	});

	test("a clean build has no errors", async () => {
		const { exec } = fakeExec({ "get build-results": out(fixture("build-results.ok.json")) });
		expect(await readBuildIssues("/r/a.xcresult", exec)).toEqual({ errors: [], warnings: 0 });
	});

	test("an error without a source location keeps the message only", async () => {
		const json = JSON.stringify({ errors: [{ message: "No profiles for 'x' were found" }], warningCount: 0 });
		const { exec } = fakeExec({ "get build-results": out(json) });
		expect(await readBuildIssues("/r/a.xcresult", exec)).toEqual({
			errors: [{ message: "No profiles for 'x' were found" }],
			warnings: 0,
		});
	});

	test("null when the tool fails, prints junk, or throws", async () => {
		const failing = fakeExec({ "get build-results": { exitCode: 1, stdout: "", stderr: "no bundle" } });
		expect(await readBuildIssues("/r/a.xcresult", failing.exec)).toBeNull();
		const junk = fakeExec({ "get build-results": out("not json") });
		expect(await readBuildIssues("/r/a.xcresult", junk.exec)).toBeNull();
		const wrongShape = fakeExec({ "get build-results": out("[1,2]") });
		expect(await readBuildIssues("/r/a.xcresult", wrongShape.exec)).toBeNull();
		const throwing: Exec = async () => {
			throw new Error("boom");
		};
		expect(await readBuildIssues("/r/a.xcresult", throwing)).toBeNull();
	});
});

describe("readTestFailures", () => {
	test("failure messages with file:line from the test tree, named after their test", async () => {
		const { exec } = fakeExec({
			"get test-results summary": out(fixture("test-summary.failed.json")),
			"get test-results tests": out(fixture("test-tests.failed.json")),
		});
		expect(await readTestFailures("/r/t.xcresult", exec)).toEqual([
			{
				test: "DemoTests/testAnswer()",
				message: 'XCTAssertEqual failed: ("42") is not equal to ("41") - answer is wrong',
				file: "/Users/dev/Demo/Tests/DemoTests/DemoTests.swift",
				line: 4,
			},
		]);
	});

	test("a `file:line: message` failure name is split", async () => {
		const tree = {
			testNodes: [
				{
					nodeType: "Test Case",
					nodeIdentifier: "RunnerTests/testServe()",
					children: [{ nodeType: "Failure Message", name: "/src/RunnerTests.swift:88: Lost connection to the app" }],
				},
			],
		};
		const { exec } = fakeExec({
			"get test-results summary": out(JSON.stringify({ testFailures: [] })),
			"get test-results tests": out(JSON.stringify(tree)),
		});
		expect(await readTestFailures("/r/t.xcresult", exec)).toEqual([
			{
				test: "RunnerTests/testServe()",
				message: "Lost connection to the app",
				file: "/src/RunnerTests.swift",
				line: 88,
			},
		]);
	});

	test("falls back to the summary's failures when the tree has none", async () => {
		const summary = {
			testFailures: [{ failureText: "Test crashed with signal kill", testIdentifierString: "RunnerTests/testServe()" }],
		};
		const { exec } = fakeExec({
			"get test-results summary": out(JSON.stringify(summary)),
			"get test-results tests": out(JSON.stringify({ testNodes: [] })),
		});
		expect(await readTestFailures("/r/t.xcresult", exec)).toEqual([
			{ test: "RunnerTests/testServe()", message: "Test crashed with signal kill" },
		]);
	});

	test("null when the summary cannot be read", async () => {
		const { exec } = fakeExec({ "get test-results summary": { exitCode: 1, stdout: "", stderr: "x" } });
		expect(await readTestFailures("/r/t.xcresult", exec)).toBeNull();
	});
});

describe("formatting", () => {
	test("first errors with file:line, then a count of the rest", () => {
		const errors = Array.from({ length: 7 }, (_, i) => ({ message: `e${i}`, file: `/a/F${i}.swift`, line: i + 1 }));
		expect(formatBuildIssues({ errors, warnings: 2 })).toBe(
			"7 errors: /a/F0.swift:1: e0; /a/F1.swift:2: e1; /a/F2.swift:3: e2; /a/F3.swift:4: e3; /a/F4.swift:5: e4 (+2 more)"
		);
		expect(formatBuildIssues({ errors: [{ message: "signing" }], warnings: 0 })).toBe("1 error: signing");
		expect(formatBuildIssues({ errors: [], warnings: 3 })).toBeUndefined();
	});

	test("test failures read as `test: file:line: message`", () => {
		expect(
			formatTestFailures([{ test: "T/a()", message: "boom", file: "/s/T.swift", line: 3 }, { message: "crashed" }])
		).toBe("T/a(): /s/T.swift:3: boom; crashed");
		expect(formatTestFailures([])).toBeUndefined();
	});
});

describe("result bundles on disk", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-xcresult-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("resultsDirFor: `results/` beside the derived data", () => {
		expect(resultsDirFor("/cache/team/abc/dd")).toBe("/cache/team/abc/results");
	});

	test("a fresh path per call; only the newest 3 bundles of one tag stay", () => {
		const results = join(dir, "results");
		const made: string[] = [];
		for (let i = 0; i < 5; i++) {
			const path = prepareResultBundle(results, "build", () => 1_000 + i);
			expect(existsSync(path)).toBe(false);
			mkdirSync(path);
			utimesSync(path, new Date(1_000 + i), new Date(1_000 + i));
			made.push(path);
		}
		const other = prepareResultBundle(results, "serve-UDID", () => 9_000);
		mkdirSync(other);
		const left = readdirSync(results).sort();
		expect(left).toEqual([
			"build-1002.xcresult",
			"build-1003.xcresult",
			"build-1004.xcresult",
			"serve-UDID-9000.xcresult",
		]);
		expect(made.at(-1)).toBe(join(results, "build-1004.xcresult"));
	});

	test("a leftover bundle at the same path is removed first", () => {
		const results = join(dir, "results");
		const first = prepareResultBundle(results, "build", () => 5);
		mkdirSync(first);
		expect(prepareResultBundle(results, "build", () => 5)).toBe(first);
		expect(existsSync(first)).toBe(false);
	});
});
