import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./cli";
import { buildSampleRun, withRepCpu } from "./report/fixtures/make-sample";
import { writeBenchResults } from "./results/write";

const BASELINE = join(import.meta.dir, "../baselines/ios-warden.json");

let out: string[];
let errs: string[];
beforeEach(() => {
	out = [];
	errs = [];
	spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
	spyOn(console, "error").mockImplementation((...a: unknown[]) => void errs.push(a.join(" ")));
});
afterEach(() => {
	for (const m of [console.log, console.error] as unknown as { mockRestore?: () => void }[]) m.mockRestore?.();
});

/** A run dir whose warden reps all use `cpu` CPU-seconds. */
function runDir(root: string, name: string, cpu: number): string {
	const dir = join(root, name);
	writeBenchResults(
		dir,
		withRepCpu(buildSampleRun(), (fw) => (fw === "warden" ? cpu : 5))
	);
	return dir;
}

describe("bench compare --max-cpu-regression", () => {
	test("exit 0 and the markdown when B is within the threshold", async () => {
		const root = mkdtempSync(join(tmpdir(), "cli-"));
		const code = await main(["compare", runDir(root, "a", 9), runDir(root, "b", 9.5), "--max-cpu-regression", "10%"]);
		expect(code).toBe(0);
		expect(out.join("\n")).toContain("# e2e framework benchmark — compare");
		expect(out.join("\n")).toContain("ok: warden cpu-s/rep 9.00 → 9.50");
	});

	test("exit 1 with the regression line on stderr when B crosses it", async () => {
		const root = mkdtempSync(join(tmpdir(), "cli-"));
		const code = await main(["compare", runDir(root, "a", 9), runDir(root, "b", 10.5), "--max-cpu-regression", "10"]);
		expect(code).toBe(1);
		expect(errs).toContain("regression: warden cpu-s/rep 9.00 → 10.50 (+16.7 %) exceeds 10 %");
	});

	test("without the flag it only prints the diff", async () => {
		const root = mkdtempSync(join(tmpdir(), "cli-"));
		expect(await main(["compare", runDir(root, "a", 9), runDir(root, "b", 99)])).toBe(0);
	});

	test("exit 2 when warden is missing from a side", async () => {
		const root = mkdtempSync(join(tmpdir(), "cli-"));
		const noWarden = join(root, "nw");
		const run = buildSampleRun();
		writeBenchResults(noWarden, { ...run, frameworks: run.frameworks.filter((f) => f.framework !== "warden") });
		const code = await main(["compare", runDir(root, "a", 9), noWarden, "--max-cpu-regression", "10"]);
		expect(code).toBe(2);
		expect(errs.join("\n")).toContain("warden is not an ok framework in B");
	});

	test("a baseline file as A guards the run and needs the flag", async () => {
		const root = mkdtempSync(join(tmpdir(), "cli-"));
		const b = runDir(root, "b", 9.12);
		expect(await main(["compare", BASELINE, b])).toBe(2);
		const slow = runDir(root, "slow", 20);
		expect(await main(["compare", BASELINE, slow, "--max-cpu-regression", "10%"])).toBe(1);
		expect(errs.join("\n")).toContain("regression: warden cpu-s/rep 9.12 → 20.00");
	});
});

describe("bench merge", () => {
	test("merges worker dirs, writes reports, exits 2 on a repeated framework", async () => {
		const root = mkdtempSync(join(tmpdir(), "cli-"));
		const run = buildSampleRun();
		const dirs = ["warden", "argent"].map((fw) => {
			const dir = join(root, fw);
			writeBenchResults(dir, { ...run, id: fw, frameworks: run.frameworks.filter((f) => f.framework === fw) });
			writeFileSync(join(dir, "bench-run.log"), fw);
			return dir;
		});
		const outDir = join(root, "merged");
		expect(await main(["merge", outDir, ...dirs, "--id", "m1"])).toBe(0);
		expect(existsSync(join(outDir, "report.md"))).toBe(true);
		expect(existsSync(join(outDir, "workers/argent/bench-run.log"))).toBe(true);
		expect(await main(["merge", join(root, "again"), dirs[0] ?? "", dirs[0] ?? ""])).toBe(2);
		expect(errs.join("\n")).toContain("framework warden appears in more than one input");
	});
});
