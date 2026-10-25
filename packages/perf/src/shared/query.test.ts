import { describe, expect, test } from "bun:test";
import type { CpuProfile } from "../js/cpu-profile";
import type { Commit } from "../react/react.types";
import {
	commitsByComponent,
	commitsByIndex,
	commitsByWindow,
	commitsCascade,
	cpuTree,
	cpuWindow,
	jsCallers,
} from "./query";

const fiber = (name: string, selfMs: number, causes: Commit["fibers"][number]["causes"] = null) => ({
	id: 1,
	name,
	actualMs: selfMs,
	selfMs,
	causes,
	memo: false,
	compiler: false,
});

const commit = (
	index: number,
	startMs: number,
	durationMs: number,
	fibers: Commit["fibers"],
	updaters: string[] = []
): Commit => ({
	index,
	root: "r",
	startMs,
	wallMs: 1000 + startMs,
	durationMs,
	effectMs: 0,
	passiveEffectMs: 0,
	updaters,
	fibers,
});

const parentCause = { firstMount: false, props: [], state: false, hooks: [], context: false };

const commits: Commit[] = [
	commit(0, 100, 20, [fiber("List", 15), fiber("Row", 5)], ["App"]),
	commit(1, 1200, 60, [fiber("List", 30), fiber("Row", 20, parentCause), fiber("Row", 10, parentCause)], ["App"]),
	commit(2, 1500, 8, [fiber("Badge", 8)], ["Badge"]),
];

describe("commit queries", () => {
	test("by component ranks by self time", () => {
		const rows = commitsByComponent(commits);
		expect(rows.map((r) => r.name)).toEqual(["List", "Row", "Badge"]);
		expect(rows[0]).toMatchObject({ renders: 2, sumSelfMs: 45, maxSelfMs: 30 });
	});

	test("by window buckets and ranks busiest first", () => {
		const rows = commitsByWindow(commits, 1000);
		expect(rows[0]).toMatchObject({ fromMs: 1000, commits: 2, renderMs: 68, worstMs: 60 });
		expect(rows[0]?.top[0]).toBe("List");
	});

	test("by index lists the slowest, or one commit in depth", () => {
		expect(commitsByIndex(commits, { limit: 1 })[0]?.index).toBe(1);
		const one = commitsByIndex(commits, { only: 1 });
		expect(one).toHaveLength(1);
		expect(one[0]?.top.map((t) => t.cause)).toContain("parent");
	});

	test("cascade counts parent-driven re-renders per updater", () => {
		const [top] = commitsCascade(commits);
		expect(top).toMatchObject({ origin: "App", commits: 2, cascadeFibers: 2 });
	});
});

const node = (id: number, functionName: string, children: number[] = []) => ({
	id,
	callFrame: { functionName, url: "", scriptId: "1", lineNumber: id, columnNumber: 0 },
	children,
});

/** root -> app -> (parse, render); samples 4x parse, 2x render, 4x idle; 1ms apart (1000us) */
const profile: CpuProfile = {
	nodes: [node(1, "(root)", [2, 5]), node(2, "app", [3, 4]), node(3, "parse"), node(4, "render"), node(5, "(idle)")],
	startTime: 0,
	endTime: 10_000,
	samples: [3, 3, 3, 3, 4, 4, 5, 5, 5, 5],
	timeDeltas: Array(10).fill(1000),
};
const label = (f: { functionName: string }) => ({ name: f.functionName });

describe("cpu queries", () => {
	test("window keeps only the samples inside it", () => {
		const rows = cpuWindow(profile, label, { fromMs: 5000, toMs: 5004, profileStartMs: 5000 });
		expect(rows[0]).toMatchObject({ name: "parse" });
		const later = cpuWindow(profile, label, { fromMs: 5005, toMs: 5008, profileStartMs: 5000 });
		expect(later.map((r) => r.name)).toEqual(["render"]);
	});

	test("tree nests by total time and drops idle", () => {
		const rows = cpuTree(profile, label, { minPct: 0 });
		expect(rows.map((r) => [r.depth, r.name])).toEqual([
			[1, "app"],
			[2, "parse"],
			[2, "render"],
		]);
		expect(rows[0]?.totalPct).toBe(100);
	});

	test("callers sum the time under each caller", () => {
		expect(jsCallers(profile, label, "parse")).toEqual([{ caller: "app", ms: 4, pct: 100 }]);
	});
});
