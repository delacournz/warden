import { describe, expect, test } from "bun:test";
import { buildProfile } from "../js/js.testing";
import type { Finding } from "../shared/findings.types";
import { analyzeReact, reactSection } from "./analyze";
import { indexProfile } from "./pipeline/cpu-correlate";
import { hotCommits, tierOf } from "./pipeline/hot-commits";
import { rankComponents } from "./pipeline/rank";
import { reduceComponents } from "./pipeline/reduce";
import { tagComponents } from "./pipeline/tag";
import { loadCommitsFixture } from "./react.testing";

const file = loadCommitsFixture();
const analysis = analyzeReact(file, { sessionId: "20261024-100000-abc123" });
const of = <K extends Finding["kind"]>(kind: K) =>
	analysis.findings.filter((f): f is Extract<Finding, { kind: K }> => f.kind === kind);

describe("hot commits", () => {
	test("absolute floor: under 16ms ok, 16-50 warm, over 50 hot", () => {
		expect(tierOf(15.9)).toBe("ok");
		expect(tierOf(16)).toBe("warm");
		expect(tierOf(50)).toBe("warm");
		expect(tierOf(50.1)).toBe("hot");
	});

	test("lists warm and hot commits slowest first with cbrt heat", () => {
		const hot = hotCommits(file.commits);
		expect(hot[0]).toMatchObject({ index: 0, durationMs: 140, tier: "hot", heat: 1 });
		const warm = hot.find((h) => h.durationMs === 38);
		expect(warm?.heat).toBeCloseTo(Math.cbrt(38 / 140), 5);
		expect(hot.every((h) => h.durationMs >= 16)).toBe(true);
		expect(hot[0]?.top[0]?.name).toBe("ChartBar");
		expect(hot[0]?.top[0]?.count).toBe(60);
	});
});

describe("reduce / tag / rank", () => {
	const stats = tagComponents(reduceComponents(file.commits));
	const by = (name: string) => stats.find((s) => s.name === name);

	test("per component n, sum, max, mean of self time and causes", () => {
		const row = by("FeedRow");
		expect(row).toMatchObject({ renders: 40, memo: true });
		expect(row?.sumSelfMs).toBeCloseTo(96, 5);
		expect(row?.meanSelfMs).toBeCloseTo(2.4, 5);
		expect(row?.causes.props).toBe(40);
		expect(row?.propKeys).toEqual({ onPress: 40, style: 40 });
		expect(by("Avatar")?.causes.parent).toBe(40);
	});

	test("tags animation and transition components", () => {
		expect(by("SpinnerOverlay")?.tag).toBe("animated");
		expect(by("AppNavigator")?.tag).toBe("transition");
		expect(by("FeedRow")?.tag).toBeUndefined();
	});

	test("ranks renders >= 3 or max >= 30ms, costliest first", () => {
		const ranked = rankComponents(stats).map((s) => s.name);
		expect(ranked).toContain("ExpensiveSort");
		expect(ranked).not.toContain("App");
		expect(ranked.indexOf("ExpensiveSort")).toBeLessThan(ranked.indexOf("Avatar"));
	});
});

describe("findings", () => {
	test("slow-commit: hot is critical, warm is warn, with the commit index", () => {
		const first = of("slow-commit").find((f) => f.commitIndex === 0);
		expect(first).toMatchObject({ severity: "critical", costMs: 140 });
		expect(first?.evidence).toContain("ChartBar×60");
		expect(of("slow-commit").some((f) => f.severity === "warn")).toBe(true);
	});

	test("slow-render: the 70ms sort", () => {
		const f = of("slow-render").find((x) => x.component === "ExpensiveSort");
		expect(f).toMatchObject({ severity: "critical" });
		expect(f?.costMs).toBeCloseTo(67 + 32 + 30, 5);
	});

	test("memo-defeated: memoized rows re-render on fresh callbacks, naming the props", () => {
		const f = of("memo-defeated").find((x) => x.component === "FeedRow");
		expect(f?.evidence).toContain("onPress");
		expect(f?.fix).toContain("useCallback");
	});

	test("parent-cascade: avatars re-render with nothing changed", () => {
		const f = of("parent-cascade").find((x) => x.component === "Avatar");
		expect(f?.evidence).toContain("parent FeedRow");
	});

	test("context-cascade: names the provider and its consumers", () => {
		const f = of("context-cascade")[0];
		expect(f).toMatchObject({ component: "ThemeProvider" });
		expect(f?.evidence).toContain("ThemedText");
		expect(f?.evidence).toContain("30 consumers");
	});

	test("render-storm: animation-driven is info, a state-driven clock is a warning", () => {
		const storms = of("render-storm");
		expect(storms.find((s) => s.component === "SpinnerOverlay")).toMatchObject({ severity: "info", renders: 14 });
		expect(storms.find((s) => s.component === "ClockLabel")).toMatchObject({ severity: "warn", renders: 12 });
	});

	test("effect-chain: back-to-back commits set off by effects are not also a storm", () => {
		const chain = of("effect-chain");
		expect(chain).toHaveLength(1);
		expect(chain[0]).toMatchObject({ component: "SearchBox" });
		expect(chain[0]?.evidence).toContain("4 back-to-back commits");
		expect(of("render-storm").some((s) => s.component === "SearchBox")).toBe(false);
	});

	test("eager-mount: the chart subtree, not the app root or the repeated bars", () => {
		const f = of("eager-mount");
		expect(f.map((x) => x.component)).toEqual(["HeavyChart"]);
		expect(f[0]?.evidence).toContain("61 components");
		expect(f[0]?.fix).toContain("FlatList");
	});

	test("every finding is above the cost floor and carries a fix and next", () => {
		expect(analysis.findings.length).toBeGreaterThan(8);
		for (const f of analysis.findings) {
			expect(f.costMs).toBeGreaterThanOrEqual(2);
			expect(f.fix.length).toBeGreaterThan(10);
			expect(f.next.length).toBeGreaterThan(0);
		}
	});

	test("components under 3% of render time are not reported", () => {
		expect(analysis.findings.some((f) => "component" in f && f.component === "App")).toBe(false);
	});

	test("locate adds file:line to the evidence", () => {
		const located = analyzeReact(file, {
			locate: (n) => (n === "ExpensiveSort" ? { file: "src/ExpensiveSort.tsx", line: 14 } : undefined),
		});
		const f = located.findings.find((x) => x.kind === "slow-render" && x.component === "ExpensiveSort");
		expect(f?.evidence).toContain("(src/ExpensiveSort.tsx:14)");
		expect(located.components.find((c) => c.name === "ExpensiveSort")?.source).toEqual({
			file: "src/ExpensiveSort.tsx",
			line: 14,
		});
	});

	test("a compiled component is not blamed for cascades", () => {
		const compiled = structuredClone(file);
		for (const c of compiled.commits) for (const f of c.fibers) if (f.name === "Avatar") f.compiler = true;
		expect(analyzeReact(compiled).findings.some((f) => f.kind === "parent-cascade")).toBe(false);
	});

	test("an empty recording has no findings", () => {
		const empty = analyzeReact({ ...file, commits: [] });
		expect(empty.findings).toEqual([]);
		expect(empty.totals.commits).toBe(0);
	});
});

describe("cpu correlation", () => {
	test("lists the top self-time functions inside each hot commit's window", () => {
		const hot0 = hotCommits(file.commits)[0];
		if (hot0 === undefined) throw new Error("no hot commit");
		// 1ms samples: 60 in `layout` then 40 in `sortRows`, all inside commit #0's 140ms window
		const samples: Array<[number, number]> = [[1, 0]];
		for (let i = 0; i < 60; i++) samples.push([2, 1000]);
		for (let i = 0; i < 40; i++) samples.push([3, 1000]);
		const profile = buildProfile(
			[
				{ id: 1, name: "(root)", children: [2, 3] },
				{ id: 2, name: "layout", url: "bundle", line: 4 },
				{ id: 3, name: "sortRows", url: "bundle", line: 9 },
			],
			samples
		);
		const index = indexProfile(profile, hot0.wallMs);
		const withCpu = analyzeReact(file, {
			cpu: { index, label: (f) => ({ name: f.functionName, file: "src/list.ts", line: f.lineNumber ?? 0 }) },
		});
		const first = withCpu.hotCommits.find((h) => h.index === 0);
		expect(first?.cpu.map((c) => c.name)).toEqual(["layout", "sortRows"]);
		expect(first?.cpu[0]?.selfMs).toBeGreaterThan(40);
		expect(withCpu.hotCommits.find((h) => h.durationMs === 70)?.cpu).toEqual([]);
	});
});

describe("section", () => {
	test("summary, the top 10 hot commits inline, components with timings", () => {
		const lines = reactSection(analysis).lines;
		expect(lines[0]).toContain("commits in 10.0s");
		expect(lines.filter((l) => l.startsWith("- #")).length).toBe(analysis.hotCommits.length);
		expect(lines.some((l) => l.includes("more in react/findings.json"))).toBe(false);
		const cut = reactSection(analysis, { commits: 3 }).lines;
		expect(cut.filter((l) => l.startsWith("- #")).length).toBe(3);
		expect(cut.some((l) => l.includes("more in react/findings.json"))).toBe(true);
		expect(lines.join("\n")).toContain("dev build (__DEV__)");
		expect(lines.join("\n")).toContain("ExpensiveSort n=3");
	});
});
