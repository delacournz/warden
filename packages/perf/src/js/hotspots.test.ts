import { describe, expect, test } from "bun:test";
import { analyzeProfile, hotspotFindings, hotspotsSection, packageOf } from "./hotspots";
import { buildProfile } from "./js.testing";
import type { FrameResolver } from "./symbolicate";

const unmapped: FrameResolver = (f) => ({
	source: undefined,
	line: (f.lineNumber ?? 0) + 1,
	column: (f.columnNumber ?? 0) + 1,
	name: undefined,
});

/** by node id: 10 -> src/app.ts:5 `render`; 11 -> node_modules/@s/pkg/x.js:2 `parse` */
const mapped: FrameResolver = (f) => {
	if (f.lineNumber === 10) return { source: "src/app.ts", line: 5, column: 1, name: "render" };
	if (f.lineNumber === 11) return { source: "/p/node_modules/@s/pkg/x.js", line: 2, column: 1, name: "parse" };
	return unmapped(f);
};

const nodes = [
	{ id: 1, name: "(root)", children: [2, 3, 4, 5] },
	{ id: 2, name: "a", line: 10, url: "http://x/index.bundle", children: [6] },
	{ id: 3, name: "(idle)" },
	{ id: 4, name: "(program)" },
	{ id: 5, name: "(garbage collector)" },
	{ id: 6, name: "b", line: 11, url: "http://x/index.bundle" },
];

// sample time = the next delta: [2]=100ms [6]=300ms [6]=300ms [3]=1000ms [4]=50ms [5]=20ms
const samples: Array<[number, number]> = [
	[2, 0],
	[6, 100_000],
	[6, 300_000],
	[3, 300_000],
	[4, 1_000_000],
	[5, 50_000],
];

describe("analyzeProfile", () => {
	const h = analyzeProfile(buildProfile(nodes, [...samples, [3, 20_000]]), mapped, { top: 5 });

	test("separates idle, native (program) and gc time", () => {
		expect(h.idleMs).toBe(1020);
		expect(h.programMs).toBe(50);
		expect(h.gcMs).toBe(20);
		expect(h.idlePct).toBeGreaterThan(50);
	});

	test("self and total time per function, percent of active time", () => {
		const [top] = h.topSelf;
		expect(top).toMatchObject({
			name: "parse",
			file: "/p/node_modules/@s/pkg/x.js",
			line: 2,
			mapped: true,
			selfMs: 600,
		});
		const a = h.topTotal.find((f) => f.name === "render");
		expect(a).toMatchObject({ selfMs: 100, totalMs: 700, file: "src/app.ts", line: 5 });
		expect(h.activeMs).toBe(h.durationMs - 1020);
	});

	test("node_modules frames are grouped by package", () => {
		expect(h.packages).toEqual([{ name: "@s/pkg", selfMs: 600, selfPct: expect.any(Number) }]);
		expect(h.topSelf[0]?.package).toBe("@s/pkg");
	});

	test("pseudo-frames never appear in the function tables", () => {
		const names = [...h.topSelf, ...h.topTotal].map((f) => f.name);
		for (const special of ["(root)", "(idle)", "(program)", "(garbage collector)"])
			expect(names).not.toContain(special);
	});

	test("recursion counts total once per sample", () => {
		const recursive = buildProfile(
			[
				{ id: 1, name: "(root)", children: [2] },
				{ id: 2, name: "r", line: 3, children: [3] },
				{ id: 3, name: "r", line: 3 },
			],
			[
				[3, 0],
				[3, 10_000],
			]
		);
		const r = analyzeProfile(recursive, unmapped).topTotal.find((f) => f.name === "r");
		expect(r?.totalMs).toBe(20);
	});

	test("unmapped frames keep the bundle position and are reported", () => {
		const u = analyzeProfile(buildProfile(nodes, samples), unmapped);
		expect(u.topSelf[0]?.mapped).toBe(false);
		expect(u.unmappedPct).toBe(100);
	});

	test("an empty sample list falls back to hit counts", () => {
		const profile = buildProfile(
			[
				{ id: 1, name: "(root)", children: [2] },
				{ id: 2, name: "x", line: 1 },
			],
			[]
		);
		const node = profile.nodes[1];
		if (node) (node as { hitCount?: number }).hitCount = 50;
		const f = analyzeProfile(profile, unmapped, { samplingIntervalUs: 1000 });
		expect(f.topSelf[0]).toMatchObject({ name: "x", selfMs: 50 });
	});
});

describe("hotspotFindings", () => {
	test("a dominant function is a js-hotspot finding at its source position", () => {
		const h = analyzeProfile(buildProfile(nodes, samples), mapped);
		const findings = hotspotFindings(h);
		expect(findings[0]).toMatchObject({
			kind: "js-hotspot",
			file: "/p/node_modules/@s/pkg/x.js",
			line: 2,
			costMs: 600,
		});
		expect(findings[0]?.severity).toBe("critical");
	});

	test("small shares make no finding", () => {
		const small = buildProfile(
			[
				{ id: 1, name: "(root)", children: [2] },
				{ id: 2, name: "x", line: 1 },
			],
			[
				[2, 0],
				[2, 5_000],
			]
		);
		expect(hotspotFindings(analyzeProfile(small, unmapped))).toEqual([]);
	});
});

describe("hotspotsSection", () => {
	test("lists top self and total with file:line", () => {
		const text = hotspotsSection(analyzeProfile(buildProfile(nodes, samples), mapped)).lines.join("\n");
		expect(text).toContain("parse  /p/node_modules/@s/pkg/x.js:2");
		expect(text).toContain("node_modules by self time:");
		expect(text).toContain("idle");
	});
});

describe("packageOf", () => {
	test("innermost package, scoped or not", () => {
		expect(packageOf("/p/node_modules/a/node_modules/@s/b/x.js")).toBe("@s/b");
		expect(packageOf("node_modules/lodash/debounce.js")).toBe("lodash");
		expect(packageOf("src/app.ts")).toBeUndefined();
	});
});
