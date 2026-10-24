import { afterEach, describe, expect, test } from "bun:test";
import { buildProfile } from "@delacour/warden-perf/js/js.testing";
import { type TestContext, testContext } from "../testing";
import { hangLines, type PerfQueryOptions, parseWindow, perfQuery } from "./query";
import { fixtureText, SEED_T0, seedSession } from "./session-fixture.testing";
import { asMe, fakePerfDeps } from "./testing";

let ctx: TestContext | undefined;
afterEach(() => ctx?.cleanup());

const FULL = "20261024-100000-aaaaaa";
const BARE = "20261024-100100-bbbbbb";

const hotspots = {
	version: 1,
	durationMs: 10_000,
	sampleCount: 100,
	idleMs: 0,
	idlePct: 0,
	programMs: 0,
	gcMs: 0,
	activeMs: 10_000,
	anchor: { hostWallMs: SEED_T0 + 1000, deviceWallMs: SEED_T0 + 1000 },
	topSelf: [
		{
			name: "parseFeed",
			file: "src/feed.ts",
			line: 12,
			column: 1,
			mapped: true,
			selfMs: 600,
			totalMs: 900,
			selfPct: 60,
			totalPct: 90,
		},
		{
			name: "render",
			file: "http://metro/index.bundle",
			line: 3,
			column: 1,
			mapped: false,
			selfMs: 400,
			totalMs: 400,
			selfPct: 40,
			totalPct: 40,
		},
	],
	topTotal: [],
	packages: [],
	unmappedPct: 40,
	warnings: [],
};

const profile = buildProfile(
	[
		{ id: 1, name: "(root)", children: [2] },
		{ id: 2, name: "parseFeed", children: [3] },
		{ id: 3, name: "decode" },
	],
	[
		[2, 1_000_000],
		[3, 1_000_000],
		[3, 1_000_000],
	]
);

const iosNative = {
	traceStartWallMs: SEED_T0,
	hangs: [
		{
			atMs: 3200,
			durationMs: 412,
			kind: "Hang",
			topFunctions: [{ name: "layoutSubviews", samples: 40 }],
			chains: [{ chain: "main > UIKit > layoutSubviews", samples: 40 }],
		},
	],
	hotspots: [{ frame: "layoutSubviews", thread: "main", selfPct: 21.4 }],
	threads: [{ thread: "main", pct: 70 }],
	leaks: [{ type: "FeedCell", count: 3, bytes: 96, frame: "makeCell" }],
};

const frames = {
	status: "ok",
	fps: 55,
	jankPct: 6.5,
	frozenFrames: 1,
	worstWindows: [
		{ startOffsetMs: 3000, endOffsetMs: 3500, missedDeadlineFrameCount: 9, worstFrameMs: 88, mark: "scroll feed" },
	],
};

function setup() {
	const c = testContext([], { now: () => SEED_T0 + 60_000 });
	ctx = c;
	asMe(c);
	const deps = fakePerfDeps([]);
	seedSession(c, {
		id: FULL,
		files: {
			"react/commits.json": fixtureText("react-commits.json"),
			"js/hotspots.json": hotspots,
			"js/cpu.cpuprofile": profile,
			"native/ios-native.json": iosNative,
			"frames.json": frames,
		},
	});
	seedSession(c, { id: BARE, startMs: SEED_T0 + 60_000 });
	return { c, deps };
}

const run = async (
	c: TestContext,
	deps: ReturnType<typeof fakePerfDeps>,
	id: string,
	topic: string,
	rest: string[] = [],
	opts: Partial<PerfQueryOptions> = {}
) => {
	c.stdout.length = 0;
	c.stderr.length = 0;
	const code = await perfQuery(c, deps, id, topic, rest, { record: false, json: true, ...opts });
	return { code, doc: JSON.parse(c.stdout.at(-1) ?? "null") };
};

describe("perf query commits", () => {
	test("--by component (default) ranks components by summed self time", async () => {
		const { c, deps } = setup();
		const { code, doc } = await run(c, deps, FULL, "commits");
		expect(code).toBe(0);
		expect(doc).toMatchObject({
			ok: true,
			command: "perf query",
			result: { sessionId: FULL, topic: "commits", by: "component" },
		});
		expect(doc.result.rows[0]).toMatchObject({ name: "ExpensiveSort", sumSelfMs: 129 });
		const sums = doc.result.rows.map((r: { sumSelfMs: number }) => r.sumSelfMs);
		expect(sums).toEqual([...sums].sort((a: number, b: number) => b - a));
	});

	test("--limit caps the rows", async () => {
		const { c, deps } = setup();
		const { doc } = await run(c, deps, FULL, "commits", [], { by: "component", limit: "2" });
		expect(doc.result.rows.map((r: { name: string }) => r.name)).toEqual(["ExpensiveSort", "FeedRow"]);
	});

	test("--by window buckets by --size; a bad size is a usage error", async () => {
		const { c, deps } = setup();
		const ok = await run(c, deps, FULL, "commits", [], { by: "window", size: "2s" });
		expect(ok.doc.result).toMatchObject({ by: "window", windowMs: 2000 });
		expect(ok.doc.result.rows.length).toBeGreaterThan(0);
		const bad = await run(c, deps, FULL, "commits", [], { by: "window", size: "soon" });
		expect(bad.code).toBe(1);
		expect(bad.doc).toMatchObject({ ok: false, error: { code: "usage" } });
	});

	test("--by index shows one commit in depth; unknown or non-integer index fails", async () => {
		const { c, deps } = setup();
		const one = await run(c, deps, FULL, "commits", ["0"], { by: "index" });
		expect(one.doc.result.rows).toHaveLength(1);
		expect(one.doc.result.rows[0].index).toBe(0);
		expect((await run(c, deps, FULL, "commits", [], { by: "index", index: "9999" })).doc.error.message).toContain(
			"no commit #9999"
		);
		expect((await run(c, deps, FULL, "commits", [], { by: "index", index: "x" })).doc.error.code).toBe("usage");
	});

	test("--by cascade answers", async () => {
		const { c, deps } = setup();
		const { code, doc } = await run(c, deps, FULL, "commits", [], { by: "cascade" });
		expect(code).toBe(0);
		expect(doc.result.by).toBe("cascade");
	});

	test("an invalid --by is a usage error naming the choices", async () => {
		const { c, deps } = setup();
		const { code, doc } = await run(c, deps, FULL, "commits", [], { by: "banana" });
		expect(code).toBe(1);
		expect(doc.error).toMatchObject({ code: "usage" });
		expect(doc.error.message).toContain("component, window, index or cascade");
	});

	test("a session without a React profile says so, with the record hint", async () => {
		const { c, deps } = setup();
		const { code, doc } = await run(c, deps, BARE, "commits");
		expect(code).toBe(1);
		expect(doc.error.message).toBe("this session has no React profile");
		expect(doc.error.hint).toContain("--react");
	});
});

describe("perf query cpu", () => {
	test("--top lists the hottest JS functions from hotspots.json and native self time", async () => {
		const { c, deps } = setup();
		const { doc } = await run(c, deps, FULL, "cpu", [], { top: true });
		expect(doc.result.mode).toBe("top");
		expect(doc.result.js.map((f: { name: string }) => f.name)).toEqual(["parseFeed", "render"]);
		expect(doc.result.native).toEqual([{ name: "layoutSubviews (main)", selfPct: 21.4 }]);
	});

	test("--limit trims --top", async () => {
		const { c, deps } = setup();
		const { doc } = await run(c, deps, FULL, "cpu", [], { limit: "1" });
		expect(doc.result.js).toHaveLength(1);
	});

	test("--tree renders the call tree from the cpuprofile", async () => {
		const { c, deps } = setup();
		const { doc } = await run(c, deps, FULL, "cpu", [], { tree: true });
		expect(doc.result.mode).toBe("tree");
		expect(doc.result.rows.map((r: { name: string }) => r.name)).toEqual(["parseFeed src/feed.ts:12", "decode"]);
	});

	test("--window needs a-b form and a clock anchor", async () => {
		const { c, deps } = setup();
		const ok = await run(c, deps, FULL, "cpu", [], { window: "0s-5s" });
		expect(ok.code).toBe(0);
		expect(ok.doc.result).toMatchObject({ mode: "window", window: { fromMs: 0, toMs: 5000 } });
		const bad = await run(c, deps, FULL, "cpu", [], { window: "5s-2s" });
		expect(bad.doc.error.code).toBe("usage");
	});

	test("no profile at all is a clear failure", async () => {
		const { c, deps } = setup();
		const { code, doc } = await run(c, deps, BARE, "cpu");
		expect(code).toBe(1);
		expect(doc.error.message).toBe("this session has no CPU profile");
	});
});

describe("perf query stacks", () => {
	test("hang (default) returns the iOS hangs with top functions and chains", async () => {
		const { c, deps } = setup();
		const { doc } = await run(c, deps, FULL, "stacks");
		expect(doc.result).toMatchObject({ sub: "hang", platform: "ios" });
		const text = await (async () => {
			c.stdout.length = 0;
			await perfQuery(c, deps, FULL, "stacks", ["hang"], { record: false });
			return c.stdout.join("\n");
		})();
		expect(text).toContain("412ms @ 3.2s (trace time) Hang");
		expect(text).toContain("fn layoutSubviews  40 samples");
		expect(text).toContain("chain main > UIKit > layoutSubviews  40");
	});

	test("hang on Android prints the main-thread state split", () => {
		const lines = hangLines("android", {
			hangs: { hangs: [{ atMs: 2000, durMs: 300, jankType: "Late", main: { running: 120, io: 80, sleeping: 0 } }] },
		});
		expect(lines).toEqual(["300ms @ 2.0s Late  main: running 120ms, io 80ms"]);
	});

	test("callers finds who calls a JS function; it needs a name", async () => {
		const { c, deps } = setup();
		const { doc } = await run(c, deps, FULL, "stacks", ["callers", "decode"]);
		expect(doc.result.js[0].caller).toBe("parseFeed src/feed.ts:12");
		expect((await run(c, deps, FULL, "stacks", ["callers"])).doc.error.code).toBe("usage");
	});

	test("thread and leaks read the native report", async () => {
		const { c, deps } = setup();
		expect((await run(c, deps, FULL, "stacks", ["thread"])).doc.result.threads).toEqual([{ thread: "main", pct: 70 }]);
		expect((await run(c, deps, FULL, "stacks", ["leaks"])).doc.result.leaks[0]).toMatchObject({
			type: "FeedCell",
			count: 3,
		});
	});

	test("hang without a native profile fails with the --native hint; --rerun is Android only", async () => {
		const { c, deps } = setup();
		const none = await run(c, deps, BARE, "stacks", ["hang"]);
		expect(none.doc.error).toMatchObject({ message: "this session has no native profile" });
		expect(none.doc.error.hint).toContain("--native");
		const rerun = await run(c, deps, FULL, "stacks", ["hang"], { rerun: true });
		expect(rerun.doc.error).toMatchObject({ code: "usage" });
	});

	test("an unknown stacks subcommand is a usage error", async () => {
		const { c, deps } = setup();
		expect((await run(c, deps, FULL, "stacks", ["bogus"])).doc.error.code).toBe("usage");
	});
});

describe("perf query frames", () => {
	test("--worst lists the worst windows with their marks, plus native hangs", async () => {
		const { c, deps } = setup();
		const { doc } = await run(c, deps, FULL, "frames", [], { worst: true });
		expect(doc.result.windows).toHaveLength(1);
		expect(doc.result.hangs).toEqual(["412ms @ 3.2s (trace time) Hang"]);
		c.stdout.length = 0;
		await perfQuery(c, deps, FULL, "frames", [], { record: false, worst: true });
		const text = c.stdout.join("\n");
		expect(text).toContain("55 fps, 6.5% janky, 1 frozen");
		expect(text).toContain('3.0s..3.5s  9 frames over budget, worst 88ms  after "scroll feed"');
	});

	test("no frame data fails with the record hint", async () => {
		const { c, deps } = setup();
		const { code, doc } = await run(c, deps, BARE, "frames");
		expect(code).toBe(1);
		expect(doc.error.hint).toContain("--frames");
	});
});

describe("perf query session and topic handling", () => {
	test("an unknown topic is a usage error listing the topics", async () => {
		const { c, deps } = setup();
		const { code, doc } = await run(c, deps, FULL, "banana");
		expect(code).toBe(1);
		expect(doc.error).toMatchObject({
			code: "usage",
			message: 'unknown query "banana"',
			hint: "commits | cpu | stacks | frames",
		});
	});

	test("an unknown session is session_not_found; `latest` and a prefix resolve", async () => {
		const { c, deps } = setup();
		expect((await run(c, deps, "20260101-000000-abcdef", "commits")).doc.error.code).toBe("session_not_found");
		expect((await run(c, deps, "latest", "commits")).doc.error.message).toContain("no React profile");
		expect((await run(c, deps, "20261024-1000", "commits")).doc.result.sessionId).toBe(FULL);
	});

	test("text mode prints the lines, not JSON", async () => {
		const { c, deps } = setup();
		const code = await perfQuery(c, deps, FULL, "commits", [], { record: false });
		expect(code).toBe(0);
		expect(c.stdout[0]).toMatch(/^ExpensiveSort {2}renders \d+/);
	});

	test("a corrupt cpuprofile or commits file reads as missing, never a crash", async () => {
		const { c, deps } = setup();
		seedSession(c, {
			id: "20261024-100200-cccccc",
			startMs: SEED_T0 + 120_000,
			files: { "react/commits.json": "{", "js/cpu.cpuprofile": "{" },
		});
		expect((await run(c, deps, "20261024-100200-cccccc", "commits")).doc.error.message).toContain("no React profile");
		expect((await run(c, deps, "20261024-100200-cccccc", "cpu", [], { tree: true })).doc.error.message).toBe(
			"this session has no CPU profile"
		);
	});
});

describe("parseWindow", () => {
	test("accepts durations and bare numbers; rejects reversed, malformed and extra parts", () => {
		expect(parseWindow("2s-5s")).toEqual({ fromMs: 2000, toMs: 5000 });
		expect(parseWindow("500ms-1.5s")).toEqual({ fromMs: 500, toMs: 1500 });
		expect(parseWindow("0s-5s")).toEqual({ fromMs: 0, toMs: 5000 });
		expect(parseWindow("0-2")).toEqual({ fromMs: 0, toMs: 2000 });
		expect(parseWindow("0s-0s")).toBeUndefined();
		expect(parseWindow("5s-2s")).toBeUndefined();
		expect(parseWindow("5s")).toBeUndefined();
		expect(parseWindow("1s-2s-3s")).toBeUndefined();
		expect(parseWindow("a-b")).toBeUndefined();
	});
});
