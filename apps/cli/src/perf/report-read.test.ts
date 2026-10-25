import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, testContext } from "../testing";
import { sessionDir } from "./paths";
import {
	loadReportInput,
	nativeBrief,
	readCommitsFile,
	readSessionReport,
	reportFor,
	writeSessionReport,
} from "./report-read";
import { readSession } from "./session";
import { fixtureText, SEED_T0, samplesJsonl, seedSession, startupJson } from "./session-fixture.testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const ID = "20261024-100000-aaaaaa";

function setup() {
	const c = testContext([], { now: () => SEED_T0 + 20_000 });
	ctx = c;
	return c;
}

function load(c: TestContext, id = ID) {
	const session = readSession(c, id);
	if (session === undefined) throw new Error("seed");
	return { session, input: loadReportInput(c, session) };
}

describe("loadReportInput", () => {
	test("a session with no artifact files yields only the session: every optional part is absent", () => {
		const c = setup();
		seedSession(c, { id: ID });
		const { session, input } = load(c);
		expect(input.session).toEqual(session);
		expect(input.now).toBe(SEED_T0 + 20_000);
		for (const key of ["startup", "frames", "js", "react", "native", "logs", "crashes"] as const) {
			expect(key in input).toBe(false);
		}
	});

	test("reads metrics, startup, logs, frames, hotspots, crashes and react from their files", () => {
		const c = setup();
		seedSession(c, {
			id: ID,
			files: {
				"metrics/samples.jsonl": samplesJsonl(SEED_T0, [10, 20, 30]),
				"metrics/startup.json": startupJson(1500),
				"logs/device.log": "04-01 10:00:00.000  1  1 E App: boom\n04-01 10:00:01.000  1  1 I App: fine\n",
				"frames.json": {
					status: "ok",
					fps: 57,
					refreshHz: 60,
					jankPct: 4,
					jankyFrames: 4,
					totalFrames: 100,
					droppedFrames: 2,
					frozenFrames: 0,
					worstFrameMs: 40,
					deadlineMs: 16.7,
					worstWindows: [],
					findings: [],
				},
				"js/hotspots.json": { version: 1, topSelf: [{ name: "render", selfPct: 40 }] },
				"crashes/summary.json": { count: 2, lines: ["CRASH a", 7], findings: [] },
				"react/findings.json": {
					version: 1,
					totals: { commits: 1, renderMs: 1, warm: 0, hot: 0, components: 1, durationMs: 1 },
					hotCommits: [],
					components: [],
					findings: [],
					warnings: [],
				},
				"react/commits.json": fixtureText("react-commits.json"),
			},
		});
		const { input } = load(c);
		expect(input.metrics).toBeDefined();
		expect(input.startup).toMatchObject({ method: "am-start", summary: { cold: { medianMs: 1500 } } });
		expect(input.startup?.summary.warm).toBeUndefined();
		expect(input.logs).toBeDefined();
		expect(input.frames).toMatchObject({ fps: 57, jankPct: 4 });
		expect(input.js?.topSelf[0]?.name).toBe("render");
		expect(input.crashes).toEqual({ count: 2, lines: ["CRASH a"], findings: [] });
		expect(input.react?.commits.length).toBe(39);
		expect(input.react?.commits[0]?.top.length).toBeLessThanOrEqual(2);
	});

	test("frames.json that is not status ok is ignored", () => {
		const c = setup();
		seedSession(c, { id: ID, files: { "frames.json": { status: "unsupported", platform: "ios" } } });
		expect("frames" in load(c).input).toBe(false);
	});

	test("corrupt optional files are skipped, never thrown on", () => {
		const c = setup();
		seedSession(c, {
			id: ID,
			files: {
				"metrics/samples.jsonl": `${samplesJsonl(SEED_T0, [10, 20])}\n{not json\n`,
				"metrics/startup.json": "{broken",
				"frames.json": "",
				"js/hotspots.json": "[1,",
				"native/summary.json": "nope",
				"crashes/summary.json": "{",
				"react/findings.json": "{",
				"react/commits.json": "{",
			},
		});
		const { input } = load(c);
		expect(input.metrics).toBeDefined();
		for (const key of ["startup", "frames", "js", "native", "crashes", "react"] as const) {
			expect(key in input).toBe(false);
		}
	});

	test("native/summary.json of an unknown version or missing section is ignored", () => {
		const c = setup();
		seedSession(c, {
			id: ID,
			files: { "native/summary.json": { version: 2, platform: "ios", section: { title: "x", lines: [] } } },
		});
		expect("native" in load(c).input).toBe(false);
	});

	test("a valid native summary keeps hangs and drops malformed rows", () => {
		const c = setup();
		seedSession(c, {
			id: ID,
			files: {
				"native/summary.json": {
					version: 1,
					platform: "android",
					traceStartWallMs: SEED_T0,
					hangs: [{ atMs: 1, durationMs: 2, kind: "x" }, { atMs: "bad" }],
					topFunctions: [{ name: "f", selfPct: 3 }, { name: 5 }],
					findings: [],
					summary: ["s", 4],
					section: { title: "Native", lines: ["l", 9] },
					files: {},
				},
			},
		});
		expect(load(c).input.native).toMatchObject({
			platform: "android",
			traceStartWallMs: SEED_T0,
			hangs: [{ atMs: 1, durationMs: 2, kind: "x" }],
			topFunctions: [{ name: "f", selfPct: 3 }],
			summary: ["s"],
			section: { title: "Native", lines: ["l"] },
		});
	});
});

describe("readCommitsFile", () => {
	test("parses the React fixture; schema-invalid or corrupt JSON is undefined", () => {
		const c = setup();
		seedSession(c, { id: ID, files: { "react/commits.json": fixtureText("react-commits.json") } });
		expect(readCommitsFile(sessionDir(c, ID))?.commits).toHaveLength(39);
		writeFileSync(join(sessionDir(c, ID), "react", "commits.json"), JSON.stringify({ version: 2 }));
		expect(readCommitsFile(sessionDir(c, ID))).toBeUndefined();
		writeFileSync(join(sessionDir(c, ID), "react", "commits.json"), "{");
		expect(readCommitsFile(sessionDir(c, ID))).toBeUndefined();
	});
});

describe("report files", () => {
	test("writeSessionReport writes report.json and report.md that readSessionReport round-trips", () => {
		const c = setup();
		seedSession(c, { id: ID, files: { "metrics/samples.jsonl": samplesJsonl(SEED_T0, [10, 20, 30]) } });
		const { session } = load(c);
		const report = writeSessionReport(c, session);
		expect(existsSync(join(sessionDir(c, ID), "report.md"))).toBe(true);
		expect(readFileSync(join(sessionDir(c, ID), "report.md"), "utf8")).toContain(`perf session ${ID}`);
		expect(readSessionReport(c, ID)).toEqual(report);
		expect(report).toMatchObject({ version: 1, sessionId: ID, metrics: { cpuP95Pct: 30 } });
	});

	test("readSessionReport is undefined for a missing, corrupt or wrong-version report", () => {
		const c = setup();
		seedSession(c, { id: ID });
		expect(readSessionReport(c, ID)).toBeUndefined();
		writeFileSync(join(sessionDir(c, ID), "report.json"), "{oops");
		expect(readSessionReport(c, ID)).toBeUndefined();
		writeFileSync(join(sessionDir(c, ID), "report.json"), JSON.stringify({ version: 2, sessionId: ID, metrics: {} }));
		expect(readSessionReport(c, ID)).toBeUndefined();
	});

	test("reportFor prefers the written report, rebuilds over a corrupt one, and is undefined for no session", () => {
		const c = setup();
		seedSession(c, { id: ID, files: { "metrics/samples.jsonl": samplesJsonl(SEED_T0, [10, 20, 30]) } });
		const built = reportFor(c, ID);
		expect(built?.metrics.cpuP95Pct).toBe(30);
		const path = join(sessionDir(c, ID), "report.json");
		const edited = { ...built, summary: ["edited on disk"] };
		writeFileSync(path, JSON.stringify(edited));
		expect(reportFor(c, ID)?.summary).toEqual(["edited on disk"]);
		writeFileSync(path, "{corrupt");
		expect(reportFor(c, ID)?.metrics.cpuP95Pct).toBe(30);
		expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
		expect(reportFor(c, "20260101-000000-abcdef")).toBeUndefined();
	});
});

describe("nativeBrief", () => {
	test("iOS: hangs, hotspots and the trace start", () => {
		const brief = nativeBrief(
			"ios",
			{
				traceStartWallMs: 99,
				hangs: [{ atMs: 3200, durationMs: 412, kind: "Hang" }, { atMs: 1 }],
				hotspots: [{ frame: "layoutSubviews", selfPct: 21.4 }, { frame: "x" }],
			},
			5
		);
		expect(brief).toEqual({
			traceStartWallMs: 99,
			hangs: [{ atMs: 3200, durationMs: 412, kind: "Hang" }],
			topFunctions: [{ name: "layoutSubviews", selfPct: 21.4 }],
		});
	});

	test("Android perfetto: hangs read durMs and jankType; functions from cpu", () => {
		const brief = nativeBrief("android", {
			mode: "perfetto",
			hangs: { hangs: [{ atMs: 3200, durMs: 412, jankType: "App Deadline Missed" }] },
			cpu: { functions: [{ function: "layout", selfPct: 12 }] },
		});
		expect(brief).toEqual({
			hangs: [{ atMs: 3200, durationMs: 412, kind: "App Deadline Missed" }],
			topFunctions: [{ name: "layout", selfPct: 12 }],
		});
	});

	test("Android simpleperf: symbols from top; handle start used when the report has none", () => {
		const brief = nativeBrief("android", { mode: "simpleperf", top: [{ symbol: "memcpy", percent: 8 }] }, 42);
		expect(brief).toEqual({ traceStartWallMs: 42, hangs: [], topFunctions: [{ name: "memcpy", selfPct: 8 }] });
	});

	test("a non-object report is empty and top functions cap at 10", () => {
		expect(nativeBrief("ios", "garbage")).toEqual({ hangs: [], topFunctions: [] });
		const many = Array.from({ length: 15 }, (_, i) => ({ frame: `f${i}`, selfPct: i }));
		expect(nativeBrief("ios", { hotspots: many }).topFunctions).toHaveLength(10);
	});
});
