import { describe, expect, test } from "bun:test";
import {
	type AgentReport,
	allPassed,
	diffBaseline,
	median,
	type RanReport,
	renderComparison,
	renderMarkdown,
	reportSchema,
} from "./report";

const METRICS = {
	model: "claude-sonnet-5-5",
	toolCalls: 12,
	toolsByName: { Bash: 10, Skill: 1, Read: 1 },
	driverCalls: 10,
	driverVerbs: { "ui snapshot": 4, "ui press": 4, "ui wait": 1, ls: 1 },
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

const BASELINE = { toolCalls: 10, driverCalls: 10, stumbles: 0, wallMs: 100_000 };

function ran(overrides: Partial<RanReport> = {}): RanReport {
	return {
		tool: "warden",
		rep: 1,
		ran: true,
		version: "0.20.0",
		outcome: "passed",
		prepareMs: 1500,
		wallMs: 90_000,
		exitCode: 0,
		metrics: METRICS,
		checks: [{ check: { wait: "id=settings-screen" }, passed: true, output: "" }],
		diff: diffBaseline(BASELINE, METRICS, 90_000),
		notes: [],
		...overrides,
	};
}

function report(tools: AgentReport["tools"] = [ran()], reps = 1): AgentReport {
	return {
		reportVersion: 3,
		runId: "agent-login-20261109T000000Z",
		suite: "login",
		model: "claude-sonnet-5-5",
		platform: "ios",
		udid: "U",
		startedAt: "2026-11-09T00:00:00.000Z",
		reps,
		tools,
	};
}

/** warden 3 reps (one failed), argent 3 passing reps. */
const REPS: AgentReport["tools"] = [
	ran({ rep: 1, wallMs: 40_000 }),
	ran({ rep: 2, wallMs: 30_000, metrics: { ...METRICS, assistantTurns: 10 } }),
	ran({ rep: 3, wallMs: 90_000, outcome: "failed", checks: [{ check: { wait: "id=x" }, passed: false, output: "" }] }),
	ran({ tool: "argent", rep: 1, wallMs: 26_000, diff: undefined }),
	ran({ tool: "argent", rep: 2, wallMs: 28_000, diff: undefined }),
	ran({ tool: "argent", rep: 3, wallMs: 20_000, diff: undefined }),
];

const THREE: AgentReport["tools"] = [
	ran(),
	ran({
		tool: "argent",
		version: "0.27.0",
		wallMs: 120_000,
		metrics: { ...METRICS, toolCalls: 30, driverCalls: 25, stumbles: 0 },
		diff: undefined,
	}),
	{ tool: "agent-device", ran: false, outcome: "unavailable", reason: "agent-device is not on PATH" },
];

describe("diffBaseline", () => {
	test("deltas and percentages per metric; a 0 baseline has no percentage", () => {
		expect(diffBaseline(BASELINE, METRICS, 90_000)).toEqual([
			{ metric: "toolCalls", baseline: 10, actual: 12, delta: 2, pct: 20 },
			{ metric: "driverCalls", baseline: 10, actual: 10, delta: 0, pct: 0 },
			{ metric: "stumbles", baseline: 0, actual: 2, delta: 2 },
			{ metric: "wallMs", baseline: 100_000, actual: 90_000, delta: -10_000, pct: -10 },
		]);
	});

	test("no baseline, no diff", () => {
		expect(diffBaseline(undefined, METRICS, 1)).toBeUndefined();
	});
});

describe("reportSchema", () => {
	test("a report with ran and skipped tools round-trips through JSON", () => {
		const r = report(THREE);
		expect(reportSchema.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
	});
});

describe("allPassed", () => {
	test("every tool must have run and passed", () => {
		expect(allPassed(report())).toBe(true);
		expect(allPassed(report(THREE))).toBe(false);
	});
});

describe("renderComparison", () => {
	test("one column per tool, a dash for one that never ran, best passing value in bold", () => {
		const rows = renderComparison(report(THREE));
		expect(rows[0]).toBe("| | warden | argent | agent-device |");
		expect(rows).toContain("| outcome | ✅ passed | ✅ passed | ➖ unavailable |");
		expect(rows).toContain("| tool calls | **12** | 30 | — |");
		expect(rows).toContain("| stumbles | 2 | **0** | — |");
		expect(rows).toContain("| agent wall | **90.0 s** | 120.0 s | — |");
		expect(rows).toContain("| version | `0.20.0` | `0.27.0` | — |");
	});

	test("nothing is bolded with a single passing tool", () => {
		const rows = renderComparison(report([ran(), ran({ tool: "argent", outcome: "failed" })]));
		expect(rows.join("\n")).not.toContain("**");
	});

	test("with reps: pass rate, medians over passing reps with the wall range, checks summed", () => {
		const rows = renderComparison(report(REPS, 3));
		expect(rows[0]).toBe("| | warden | argent |");
		expect(rows).toContain("| outcome | ⚠️ 2/3 passed | ✅ 3/3 passed |");
		expect(rows).toContain("| checks | 2/3 | 3/3 |");
		expect(rows).toContain("| agent wall | 35.0 s (30.0–40.0) | **26.0 s (20.0–28.0)** |");
		expect(rows).toContain("| turns | **12** | 14 |");
	});

	test("with reps, a tool that never passed shows medians over its reps, unbolded", () => {
		const failed = REPS.map((t) => (t.tool === "warden" && t.ran ? { ...t, outcome: "failed" as const } : t));
		const rows = renderComparison(report(failed, 3));
		expect(rows).toContain("| outcome | ❌ 0/3 passed | ✅ 3/3 passed |");
		expect(rows).toContain("| agent wall | 40.0 s (30.0–90.0) | 26.0 s (20.0–28.0) |");
	});
});

describe("median", () => {
	test("middle value, mean of the middle two for an even count", () => {
		expect(median([3, 1, 2])).toBe(2);
		expect(median([4, 1, 3, 2])).toBe(2.5);
	});
});

describe("renderMarkdown", () => {
	test("headline, per-tool sections with baseline diff, and the comparison table last", () => {
		const md = renderMarkdown(report(THREE));
		expect(md).toContain("# agent bench: login — not all passed");
		expect(md).toContain("## warden ✅ passed");
		expect(md).toContain("| tool calls | 12 | 10 | +2 (+20%) |");
		expect(md).toContain("| wall | 90.0 s | 100.0 s | -10.0 s (-10%) |");
		expect(md).toContain("`stale_ref` 1");
		expect(md).toContain("`ui press` 4");
		expect(md).toContain("- ✅ `wait id=settings-screen`");
		expect(md).toContain("## agent-device ➖ unavailable");
		expect(md).toContain("- agent-device is not on PATH");
		expect(md).toContain("$0.30");
		expect(md.indexOf("## Comparison")).toBeGreaterThan(md.indexOf("## agent-device"));
		expect(md).not.toContain("rep-");
	});

	test("with reps: one section per tool with a row per rep and where its transcript is", () => {
		const md = renderMarkdown(report(REPS, 3));
		expect(md).toContain("· 3 reps");
		expect(md).toContain("## warden ⚠️ 2/3 passed");
		expect(md).toContain(
			"| rep | outcome | agent wall | prepare | turns | driver calls | stumbles | cost | error codes |"
		);
		expect(md).toContain("| 3 | ❌ failed | 90.0 s | 1.5 s | 14 | 10 | 2 | $0.30 | `stale_ref` 1 |");
		expect(md).toContain("- transcripts: `warden/rep-<n>/`");
		expect(md).toContain("Medians over passing reps");
	});
});
