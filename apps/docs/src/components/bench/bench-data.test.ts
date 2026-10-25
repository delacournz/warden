import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { benchSummarySchema } from "@delacour/warden-e2e-bench/src/report/summary";
import { orderSummaries, runLabel } from "./bench-order";

const dir = join(import.meta.dir, "../../../content/docs/bench/data");
const reports = join(import.meta.dir, "../../../../../docs/bench");

describe("committed bench summaries", () => {
	const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	test("there is at least one", () => {
		expect(files.length).toBeGreaterThan(0);
	});
	for (const file of files) {
		test(`${file} matches the summary schema and its file name`, () => {
			const parsed = benchSummarySchema.parse(JSON.parse(readFileSync(join(dir, file), "utf8")));
			expect(file).toMatch(new RegExp(`^${parsed.platform}-${parsed.date}(-[a-z0-9-]+)?\\.json$`));
		});
		test(`${file} has its Markdown report under docs/bench`, () => {
			expect(existsSync(join(reports, file.replace(/\.json$/, ".md")))).toBe(true);
		});
	}
});

const summary = (runId: string, platform: string, date: string, startedAt: string) => ({
	slug: `${platform}-${date}-${runId}`,
	summary: { runId, platform, date, startedAt },
});

describe("orderSummaries", () => {
	test("platforms in order, then the newest run first, even on the same date", () => {
		const ordered = orderSummaries([
			summary("old", "ios", "2026-10-20", "2026-10-20T05:00:00.000Z"),
			summary("droid", "android", "2026-10-17", "2026-10-17T05:00:00.000Z"),
			summary("new", "ios", "2026-10-20", "2026-10-20T11:00:00.000Z"),
			summary("older", "ios", "2026-10-15", "2026-10-15T23:00:00.000Z"),
		]);
		expect(ordered.map((e) => e.summary.runId)).toEqual(["new", "old", "older", "droid"]);
	});
});

describe("runLabel", () => {
	const perf = { runId: "ios-r2", platform: "ios", date: "2026-10-20" };
	const base = { runId: "ios-r1", platform: "ios", date: "2026-10-20" };
	const earlier = { runId: "v0-ios", platform: "ios", date: "2026-10-15" };
	const droid = { runId: "v1-android", platform: "android", date: "2026-10-20" };
	const runs = [perf, base, earlier, droid];
	test("a date alone when it is the only run of that platform that day", () => {
		expect(runLabel(earlier, runs)).toBe("2026-10-15");
		expect(runLabel(droid, runs)).toBe("2026-10-20");
	});
	test("the run id too when the platform has two runs that day", () => {
		expect(runLabel(perf, runs)).toBe("2026-10-20 · ios-r2");
	});
});
