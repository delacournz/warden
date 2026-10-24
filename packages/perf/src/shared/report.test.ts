import { describe, expect, test } from "bun:test";
import type { ReactAnalysis } from "../react/analyze";
import type { Finding } from "./findings.types";
import {
	buildReport,
	clockOffsetMs,
	correlate,
	deviceWallToSessionMs,
	markBefore,
	type ReportInput,
	renderReportMarkdown,
	summarizeLogs,
} from "./report";
import type { PerfSession } from "./session.schema";

const START = 1_000_000;

const session = (over: Partial<PerfSession> = {}): PerfSession => ({
	version: 1,
	id: "20260101-000000-abcdef",
	device: { udid: "U1", platform: "ios", name: "iPhone" },
	target: { udid: "U1", ownedByCaller: true },
	app: { id: "com.acme.shop", source: "flag" },
	startedAt: { wallMs: START },
	maxDurationMs: 30_000,
	status: "stopped",
	stoppedAt: START + 10_000,
	stopReason: "user",
	capturers: [
		{ kind: "metrics", startedAtIso: "x", state: "stopped" },
		{ kind: "js", startedAtIso: "x", state: "failed" },
	],
	marks: [{ label: "scroll feed", wallMs: START + 3000, atMs: 3000 }],
	...over,
});

const analysis = (findings: Finding[] = []): ReactAnalysis => ({
	version: 1,
	totals: { commits: 1, renderMs: 180, warm: 0, hot: 1, components: 1, durationMs: 10_000 },
	hotCommits: [],
	components: [],
	findings,
	warnings: [],
});

const slow = (costMs: number, severity: Finding["severity"]): Finding => ({
	kind: "slow-commit",
	severity,
	costMs,
	evidence: `commit ${costMs}`,
	fix: "memo",
	next: [],
	commitIndex: 1,
});

const withHang = (): ReportInput => ({
	session: session(),
	now: START + 10_000,
	react: {
		analysis: analysis(),
		commits: [{ index: 14, wallMs: START + 3100, durationMs: 180, top: ["FlatList"] }],
	},
	native: {
		platform: "ios",
		traceStartWallMs: START,
		hangs: [{ atMs: 3200, durationMs: 412, kind: "hang" }],
		topFunctions: [{ name: "layoutSubviews", selfPct: 21.4 }],
		findings: [],
		summary: [],
		section: { title: "Native CPU", lines: ["x"] },
	},
});

describe("alignment", () => {
	test("device clock offset shifts device wall times onto the session timeline", () => {
		const s = session({ startedAt: { wallMs: START, deviceWallMs: START + 500 } });
		expect(clockOffsetMs(s)).toBe(500);
		expect(deviceWallToSessionMs(s, START + 500 + 1200)).toBe(1200);
	});

	test("markBefore picks the last mark at or before the time", () => {
		const marks = [
			{ label: "a", wallMs: 0, atMs: 1000 },
			{ label: "b", wallMs: 0, atMs: 3000 },
		];
		expect(markBefore(marks, 500)).toBeUndefined();
		expect(markBefore(marks, 2000)).toBe("a");
		expect(markBefore(marks, 3000)).toBe("b");
	});
});

describe("correlate", () => {
	test("a hang overlapping a commit names the commit and the mark", () => {
		const [c] = correlate(withHang());
		expect(c?.kind).toBe("hang-commit");
		expect(c?.text).toBe("hang 412ms @ 3.2s overlaps commit #14 (FlatList, 180ms) ← mark 'scroll feed'");
	});

	test("no overlap, no correlation", () => {
		const input = withHang();
		input.react = { analysis: analysis(), commits: [{ index: 1, wallMs: START + 9000, durationMs: 50, top: [] }] };
		expect(correlate(input)).toEqual([]);
	});

	test("the commit that overlaps the most wins", () => {
		const input = withHang();
		input.react = {
			analysis: analysis(),
			commits: [
				{ index: 1, wallMs: START + 3000, durationMs: 250, top: ["A"] },
				{ index: 2, wallMs: START + 3250, durationMs: 400, top: ["B"] },
			],
		};
		expect(correlate(input)[0]?.text).toContain("commit #2");
	});

	test("a jank window correlates with a commit too", () => {
		const input: ReportInput = {
			session: session(),
			now: START,
			react: { analysis: analysis(), commits: [{ index: 3, wallMs: START + 4000, durationMs: 100, top: ["Feed"] }] },
			frames: {
				fps: 40,
				refreshHz: 60,
				jankPct: 12,
				jankyFrames: 12,
				totalFrames: 100,
				droppedFrames: 20,
				frozenFrames: 0,
				worstFrameMs: 90,
				deadlineMs: 16.7,
				worstWindows: [{ startOffsetMs: 4020, endOffsetMs: 4080, missedDeadlineFrameCount: 4, worstFrameMs: 90 }],
				findings: [],
			},
		};
		const [c] = correlate(input);
		expect(c?.kind).toBe("jank-commit");
		expect(c?.text).toContain("commit #3 (Feed, 100ms) ← mark 'scroll feed'");
	});
});

describe("buildReport", () => {
	test("findings are sorted by severity then cost", () => {
		const input: ReportInput = {
			session: session(),
			now: START,
			react: { analysis: analysis([slow(50, "warn"), slow(10, "critical"), slow(90, "warn")]), commits: [] },
		};
		expect(buildReport(input).findings.map((f) => f.costMs)).toEqual([10, 90, 50]);
	});

	test("sections follow the fixed order and the summary names failed capturers", () => {
		const input = withHang();
		input.metrics = {
			count: 3,
			durationMs: 2000,
			rssKb: { min: 1000, avg: 2000, p95: 3000, max: 3000 },
			cpuPct: { min: 1, avg: 5, p95: 20, max: 22 },
		};
		input.logs = { lines: 10, errorCount: 1, errors: ["E boom"] };
		const r = buildReport(input);
		expect(r.sections.map((s) => s.id)).toEqual(["react", "native-cpu", "hangs", "memory", "logs"]);
		expect(r.summary.join("\n")).toContain("failed: js");
		expect(r.summary.join("\n")).toContain("marks: 'scroll feed' @ 3.0s");
		expect(r.metrics.cpuP95Pct).toBe(20);
		expect(r.metrics.topCommitMs).toBe(180);
		expect(r.metrics.hangCount).toBe(1);
		expect(r.metrics.topFunctions[0]).toEqual({ name: "layoutSubviews", selfPct: 21.4 });
		expect(r.banners[0]).toContain("simulator");
	});

	test("markdown is capped and keeps the next hints", () => {
		const input = withHang();
		const r = buildReport(input);
		const md = renderReportMarkdown(r, { maxLines: 12 });
		expect(md.split("\n").length).toBeLessThanOrEqual(12);
		expect(md).toContain("next:");
		expect(md).toContain(`warden perf query ${r.sessionId} stacks hang`);
	});

	test("duration of a running session counts to now", () => {
		const r = buildReport({ session: session({ status: "running", stoppedAt: undefined }), now: START + 4000 });
		expect(r.durationMs).toBe(4000);
	});
});

describe("summarizeLogs", () => {
	test("counts lines and keeps the first error lines", () => {
		const s = summarizeLogs(
			"01-01 00:00:00.000 1 1 I Tag: ok\n01-01 00:00:01.000 1 1 E Tag: boom\n\nfatal exception here\n",
			1
		);
		expect(s).toEqual({ lines: 3, errorCount: 2, errors: ["01-01 00:00:01.000 1 1 E Tag: boom"] });
	});
});
