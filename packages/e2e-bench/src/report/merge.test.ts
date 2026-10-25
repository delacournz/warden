import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchRun, FrameworkResult, OkFrameworkResult } from "../results/schema";
import { readBenchResults, writeBenchResults } from "../results/write";
import { buildSampleRun } from "./fixtures/make-sample";
import { mergeRunDirs, mergeRuns } from "./merge";

const sample = buildSampleRun();
const isOk = (f: FrameworkResult): f is OkFrameworkResult => f.status === "ok";

/** A worker's run: the sample cut down to one framework, ratios as a lone framework would compute them (1.0). */
function worker(framework: string, patch: Partial<BenchRun> = {}): BenchRun {
	const only = sample.frameworks.filter(isOk).filter((f) => f.framework === framework);
	const run = structuredClone(sample);
	run.id = `eas-ios-${framework}`;
	run.options = { ...run.options, frameworks: only.map((f) => f.framework) };
	run.frameworks = only.map((f) => ({
		...f,
		stats: {
			...f.stats,
			ratioToFastestSuite: 1,
			perTest: Object.fromEntries(
				Object.entries(f.stats.perTest).map(([k, t]) => [k, { ...t, ratioToFastest: 1 }])
			) as typeof f.stats.perTest,
		},
	}));
	return { ...run, ...patch };
}

describe("mergeRuns", () => {
	const wardenRun = worker("warden", { startedAt: "2026-10-25T12:35:52.050Z", endedAt: "2026-10-25T12:44:05.645Z" });
	const argentRun = worker("argent", { startedAt: "2026-10-25T12:30:40.328Z", endedAt: "2026-10-25T12:41:48.097Z" });
	const adRun = worker("agent-device", { startedAt: "2026-10-25T12:16:03.510Z", endedAt: "2026-10-25T12:24:06.322Z" });

	test("unions every framework in registry order and recomputes cross-framework ratios", () => {
		const merged = mergeRuns([adRun, wardenRun, argentRun], "bench-merged");
		expect(merged.success).toBe(true);
		if (!merged.success) return;
		const run = merged.data;
		expect(run.frameworks.map((f) => f.framework)).toEqual(["warden", "argent", "agent-device"]);
		expect(run.options.frameworks).toEqual(["warden", "argent", "agent-device"]);
		const suiteRatios = run.frameworks.filter(isOk).map((f) => f.stats.ratioToFastestSuite ?? 0);
		expect(Math.min(...suiteRatios)).toBe(1);
		expect(Math.max(...suiteRatios)).toBeGreaterThan(1);
	});

	test("takes id from the argument, the earliest start, the latest end, and host/device/app from the first framework", () => {
		const merged = mergeRuns([adRun, wardenRun, argentRun], "bench-merged");
		if (!merged.success) throw new Error(merged.error);
		expect(merged.data.id).toBe("bench-merged");
		expect(merged.data.startedAt).toBe("2026-10-25T12:16:03.510Z");
		expect(merged.data.endedAt).toBe("2026-10-25T12:44:05.645Z");
		expect(merged.data.device).toEqual(wardenRun.device);
		expect(merged.data.app).toEqual(wardenRun.app);
	});

	test("a ratio left over from a worker's own lone run does not survive", () => {
		const merged = mergeRuns([wardenRun], "solo");
		if (!merged.success) throw new Error(merged.error);
		const f = merged.data.frameworks.filter(isOk)[0];
		expect(f?.stats.ratioToFastestSuite).toBe(1);
	});

	test("refuses the same framework twice", () => {
		const r = mergeRuns([wardenRun, worker("warden")], "x");
		expect(r).toEqual({ success: false, error: "framework warden appears in more than one input" });
	});

	test("refuses mixed platforms", () => {
		const android = worker("argent", { device: { ...argentRun.device, platform: "android" } });
		const r = mergeRuns([wardenRun, android], "x");
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error).toContain("platform");
	});

	test("refuses mixed app builds", () => {
		const other = worker("argent", { app: { ...argentRun.app, sha256: "deadbeef" } });
		const r = mergeRuns([wardenRun, other], "x");
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error).toContain("app sha256");
	});

	test("needs at least one input", () => {
		expect(mergeRuns([], "x")).toEqual({ success: false, error: "nothing to merge" });
	});
});

describe("mergeRunDirs", () => {
	function setup(): { root: string; dirs: string[] } {
		const root = mkdtempSync(join(tmpdir(), "merge-"));
		const dirs = ["warden", "argent"].map((fw) => {
			const dir = join(root, "in", fw);
			writeBenchResults(dir, worker(fw));
			mkdirSync(join(dir, "logs"), { recursive: true });
			writeFileSync(join(dir, "bench-run.log"), `log ${fw}`);
			writeFileSync(join(dir, "logs", `${fw}.log`), `nested ${fw}`);
			return dir;
		});
		return { root, dirs };
	}

	test("writes the merged results and copies each input under workers/<framework>/", () => {
		const { root, dirs } = setup();
		const out = join(root, "out");
		const r = mergeRunDirs(out, dirs, { id: "bench-merged" });
		expect(r.success).toBe(true);
		const merged = readBenchResults(out);
		expect(merged.success && merged.data.frameworks.map((f) => f.framework)).toEqual(["warden", "argent"]);
		expect(readFileSync(join(out, "workers/warden/bench-run.log"), "utf8")).toBe("log warden");
		expect(readFileSync(join(out, "workers/argent/logs/argent.log"), "utf8")).toBe("nested argent");
		const own = readBenchResults(join(out, "workers/warden"));
		expect(own.success && own.data.id).toBe("eas-ios-warden");
	});

	test("derives an id when none is given", () => {
		const { root, dirs } = setup();
		const out = join(root, "out");
		const r = mergeRunDirs(out, dirs, {});
		if (!r.success) throw new Error(r.error);
		expect(r.data.id).toMatch(/^merged-\d{4}-\d{2}-\d{2}-ios$/);
	});

	test("refuses and writes nothing when inputs conflict", () => {
		const { root, dirs } = setup();
		const dup = join(root, "in", "warden2");
		writeBenchResults(dup, worker("warden"));
		const out = join(root, "out");
		const r = mergeRunDirs(out, [...dirs, dup], {});
		expect(r.success).toBe(false);
		expect(existsSync(out)).toBe(false);
	});

	test("refuses an unreadable input and an out dir that already holds results", () => {
		const { root, dirs } = setup();
		expect(mergeRunDirs(join(root, "out"), [...dirs, join(root, "missing")], {}).success).toBe(false);
		const out = join(root, "out2");
		writeBenchResults(out, worker("warden"));
		const r = mergeRunDirs(out, dirs, {});
		expect(r.success).toBe(false);
		if (!r.success) expect(r.error).toContain("already has bench-results.json");
	});
});
