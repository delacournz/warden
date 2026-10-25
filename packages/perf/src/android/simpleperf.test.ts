import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSimpleperfReport, simpleperfFindings } from "./simpleperf";

test("parses the sample count and every row", () => {
	const report = parseSimpleperfReport(
		readFileSync(join(import.meta.dir, "../../fixtures/simpleperf-report.txt"), "utf8")
	);
	expect(report.samples).toBe(1520);
	expect(report.rows).toHaveLength(4);
	expect(report.rows[0]).toEqual({
		percent: 46.71,
		command: "mqt_v_js",
		dso: "/data/app/~~x/com.shop.app-y/lib/arm64/libhermes.so",
		symbol: "facebook::hermes::vm::Interpreter::interpretFunction",
	});
	expect(report.rows[3]?.symbol).toBe("[unknown]");
});

test("no table, no rows", () => {
	expect(parseSimpleperfReport("simpleperf: error: no such file")).toEqual({ samples: 0, rows: [] });
});

test("hotspot findings use the shared thresholds and convert samples to CPU ms", () => {
	const report = parseSimpleperfReport(
		readFileSync(join(import.meta.dir, "../../fixtures/simpleperf-report.txt"), "utf8")
	);
	const f = simpleperfFindings(report, 4000);
	expect(f.map((x) => x.severity)).toEqual(["critical", "warn", "warn"]);
	expect(f[0]).toMatchObject({ kind: "native-hotspot", thread: "mqt_v_js", selfPct: 46.71 });
	expect(f[0]?.costMs).toBeCloseTo((1520 * 46.71 * 10) / 4000, 3);
});
