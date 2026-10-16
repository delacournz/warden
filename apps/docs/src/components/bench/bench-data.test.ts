import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchSummarySchema } from "@delacour/warden-e2e-bench/src/report/summary";

const dir = join(import.meta.dir, "../../../content/docs/bench/data");

describe("committed bench summaries", () => {
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	test("there is at least one", () => {
		expect(files.length).toBeGreaterThan(0);
	});
	for (const file of files) {
		test(`${file} matches the summary schema and its file name`, () => {
			const parsed = benchSummarySchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
			expect(file).toBe(`${parsed.platform}-${parsed.date}.json`);
		});
	}
});
