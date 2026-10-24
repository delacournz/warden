import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProfile } from "@delacour/warden-perf/js/js.testing";
import { loadCommitsFixture } from "@delacour/warden-perf/react/react.testing";
import { analyzeAndWrite, loadCpuCorrelation } from "./react-capture";
import type { SourceDeps } from "./react-source";

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "warden-react-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const noProject: SourceDeps = { files: () => [], read: () => undefined };

describe("analyzeAndWrite", () => {
	test("writes commits.json and findings.json; the runtime's source and the project grep locate components", () => {
		const out = tmp();
		const file = loadCommitsFixture();
		const project: Record<string, string> = { "/work/shop/src/Feed.tsx": "export const FeedRow = memo(() => null);" };
		const result = analyzeAndWrite(file, {
			dir: join(out, "react"),
			cwd: "/work/shop",
			sessionId: "20261024-100000-abc123",
			sourceDeps: { files: () => Object.keys(project), read: (p) => project[p] },
		});
		expect(JSON.parse(readFileSync(result.commitsPath, "utf8")).commits).toHaveLength(file.commits.length);
		const findings = JSON.parse(readFileSync(result.findingsPath, "utf8"));
		expect(findings.findings.length).toBeGreaterThan(8);
		const sort = result.analysis.components.find((c) => c.name === "ExpensiveSort");
		expect(sort?.source).toEqual({ file: "src/results/ExpensiveSort.tsx", line: 14 });
		expect(result.analysis.components.find((c) => c.name === "FeedRow")?.source).toEqual({
			file: "src/Feed.tsx",
			line: 1,
		});
		expect(result.findings.find((f) => f.kind === "slow-render")?.evidence).toContain(
			"src/results/ExpensiveSort.tsx:14"
		);
		expect(result.findings[0]?.next.join(" ")).toContain("warden perf query 20261024-100000-abc123");
	});

	test("correlates hot commits with the session's JS profile", () => {
		const out = tmp();
		const file = loadCommitsFixture();
		const jsDir = join(out, "js");
		mkdirSync(jsDir);
		const samples: Array<[number, number]> = [[1, 0]];
		for (let i = 0; i < 100; i++) samples.push([2, 1000]);
		const profile = buildProfile(
			[
				{ id: 1, name: "(root)", children: [2] },
				{ id: 2, name: "sortRows", url: "http://m/index.bundle", line: 9 },
			],
			samples
		);
		writeFileSync(join(jsDir, "cpu.cpuprofile"), JSON.stringify(profile));
		writeFileSync(
			join(jsDir, "hotspots.json"),
			JSON.stringify({
				anchor: { hostWallMs: 1, deviceWallMs: file.anchor.startedWallMs },
				topSelf: [{ name: "sortRows", file: "src/sort.ts", line: 31, mapped: true }],
				topTotal: [],
			})
		);
		const result = analyzeAndWrite(file, { dir: join(out, "react"), jsDir, cwd: out, sourceDeps: noProject });
		const first = result.analysis.hotCommits.find((h) => h.index === 0);
		expect(first?.cpu[0]).toMatchObject({ name: "sortRows", file: "src/sort.ts", line: 31 });
		expect(first?.cpu[0]?.selfMs).toBeGreaterThan(50);
		expect(result.section.lines.join("\n")).toContain("js: sortRows src/sort.ts:31");
	});

	test("no JS profile, or one without a clock anchor, means no correlation", () => {
		const out = tmp();
		expect(loadCpuCorrelation(undefined)).toBeUndefined();
		expect(loadCpuCorrelation(join(out, "missing"))).toBeUndefined();
		const jsDir = join(out, "js");
		mkdirSync(jsDir);
		writeFileSync(join(jsDir, "cpu.cpuprofile"), JSON.stringify(buildProfile([{ id: 1, name: "(root)" }], [[1, 0]])));
		writeFileSync(join(jsDir, "hotspots.json"), JSON.stringify({ topSelf: [] }));
		expect(loadCpuCorrelation(jsDir)).toBeUndefined();
	});
});
