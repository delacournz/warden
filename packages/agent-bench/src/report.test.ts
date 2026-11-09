import { describe, expect, test } from "bun:test";
import { type AgentReport, diffBaseline, renderMarkdown, reportSchema } from "./report";

const METRICS = {
	model: "claude-sonnet-5-5",
	toolCalls: 12,
	toolsByName: { Bash: 10, Skill: 1, Read: 1 },
	wardenCalls: 10,
	wardenUiCalls: 9,
	wardenVerbs: { snapshot: 4, press: 4, wait: 1, ls: 1 },
	skillLoads: ["warden"],
	stumbles: 2,
	errorCodes: { stale_ref: 1 },
	assistantTurns: 14,
	result: {
		subtype: "success",
		isError: false,
		numTurns: 14,
		costUsd: 0.3,
		durationMs: 80_000,
		tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
	},
	unparsedLines: 0,
};

function report(overrides: Partial<AgentReport> = {}): AgentReport {
	return {
		reportVersion: 1,
		runId: "agent-login-20261109T000000Z",
		suite: "login",
		model: "claude-sonnet-5-5",
		platform: "ios",
		udid: "U",
		startedAt: "2026-11-09T00:00:00.000Z",
		wallMs: 90_000,
		outcome: "passed",
		exitCode: 0,
		metrics: METRICS,
		checks: [{ check: { wait: "id=settings-screen" }, passed: true, output: "" }],
		diff: diffBaseline({ toolCalls: 10, wardenCalls: 10, stumbles: 0, wallMs: 100_000 }, METRICS, 90_000),
		...overrides,
	};
}

describe("diffBaseline", () => {
	test("deltas and percentages per metric; a 0 baseline has no percentage", () => {
		const diff = diffBaseline({ toolCalls: 10, wardenCalls: 10, stumbles: 0, wallMs: 100_000 }, METRICS, 90_000);
		expect(diff).toEqual([
			{ metric: "toolCalls", baseline: 10, actual: 12, delta: 2, pct: 20 },
			{ metric: "wardenCalls", baseline: 10, actual: 10, delta: 0, pct: 0 },
			{ metric: "stumbles", baseline: 0, actual: 2, delta: 2 },
			{ metric: "wallMs", baseline: 100_000, actual: 90_000, delta: -10_000, pct: -10 },
		]);
	});

	test("no baseline, no diff", () => {
		expect(diffBaseline(undefined, METRICS, 1)).toBeUndefined();
	});
});

describe("reportSchema", () => {
	test("a built report round-trips through JSON", () => {
		const r = report();
		expect(reportSchema.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
	});
});

describe("renderMarkdown", () => {
	test("headline, metric table with baseline columns, tool and error breakdown, checks", () => {
		const md = renderMarkdown(report());
		expect(md).toContain("# agent bench: login — passed");
		expect(md).toContain("| tool calls | 12 | 10 | +2 (+20%) |");
		expect(md).toContain("| stumbles | 2 | 0 | +2 |");
		expect(md).toContain("| wall | 90.0 s | 100.0 s | -10.0 s (-10%) |");
		expect(md).toContain("`stale_ref` 1");
		expect(md).toContain("`press` 4");
		expect(md).toContain("- ✅ `wait id=settings-screen`");
		expect(md).toContain("$0.30");
	});

	test("without a baseline the table has no baseline columns", () => {
		const md = renderMarkdown(report({ diff: undefined }));
		expect(md).toContain("| metric | run |");
		expect(md).toContain("| tool calls | 12 |");
	});
});
