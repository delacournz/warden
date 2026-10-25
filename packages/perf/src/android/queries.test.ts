import { describe, expect, test } from "bun:test";
import { QUERIES, type QueryName, renderQuery } from "./queries";

describe("queries", () => {
	test("every query is scoped to the package token", () => {
		for (const name of Object.keys(QUERIES) as QueryName[]) expect(QUERIES[name]).toContain("{{PACKAGE}}");
	});

	test("renders the package into every occurrence", () => {
		const sql = renderQuery("ui-hangs", "com.shop.app") ?? "";
		expect(sql).not.toContain("{{");
		expect(sql).toContain("p.name = 'com.shop.app'");
	});

	test("refuses a package that could inject SQL", () => {
		expect(renderQuery("cpu-hotspots", "x' OR '1'='1")).toBeUndefined();
	});

	test("hangs only count missed app deadlines; the fold query batches every hang", () => {
		expect(QUERIES["ui-hangs"]).toContain("App Deadline Missed");
		expect(QUERIES["hang-folds-batched"]).toContain("App Deadline Missed");
		expect(QUERIES["hang-folds-batched"]).toContain("GROUP BY h.hang_id, u.bucket");
	});
});
