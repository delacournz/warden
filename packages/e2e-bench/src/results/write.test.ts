import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchRun } from "./schema";
import { parseBenchRun } from "./schema";
import { RESULTS_FILE, readBenchResults, writeBenchResults, writeFileAtomic } from "./write";

const sample = (): BenchRun => {
	const parsed = parseBenchRun(
		readFileSync(join(import.meta.dir, "../report/fixtures/bench-results.sample.json"), "utf8")
	);
	if (!parsed.success) throw new Error(parsed.error);
	return parsed.data;
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bench-write-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("writeFileAtomic", () => {
	test("replaces the file and leaves no temp file", () => {
		const path = join(dir, "a", "x.json");
		writeFileAtomic(path, "one");
		writeFileAtomic(path, "two");
		expect(readFileSync(path, "utf8")).toBe("two");
		expect(readdirSync(join(dir, "a"))).toEqual(["x.json"]);
	});
});

describe("bench results file", () => {
	test("round-trips a run", () => {
		const run = sample();
		writeBenchResults(dir, run);
		const back = readBenchResults(dir);
		expect(back.success && back.data).toEqual(run);
	});

	test("non-finite numbers become 0 so the file still validates", () => {
		const run = sample();
		const first = run.frameworks[0];
		if (first?.status !== "ok") throw new Error("fixture must start with an ok framework");
		first.stats.overheadMs = Number.NaN;
		writeBenchResults(dir, run);
		expect(readBenchResults(dir).success).toBe(true);
	});

	test("a missing file is an error naming the path", () => {
		const r = readBenchResults(join(dir, "nope"));
		expect(r.success).toBe(false);
		expect(!r.success && r.error).toContain(RESULTS_FILE);
		expect(existsSync(join(dir, "nope"))).toBe(false);
	});
});
