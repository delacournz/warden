import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadManifest } from "../results/manifest";
import { median } from "../results/stats";
import { buildSampleRun } from "./fixtures/make-sample";
import { perTestMatrix, summaryRows, untracedRows } from "./tables";

const manifest = loadManifest(join(import.meta.dir, "../.."));
const run = buildSampleRun();

describe("summaryRows", () => {
	test("one row per framework in run order, fastest flagged once", () => {
		const rows = summaryRows(run);
		expect(rows.map((r) => r.framework)).toEqual([
			"warden",
			"maestro",
			"argent",
			"agent-device",
			"tester-army",
			"detox",
		]);
		expect(rows.filter((r) => r.fastest).map((r) => r.framework)).toEqual(["warden"]);
	});
	test("non-ok rows carry only status and version", () => {
		const rows = summaryRows(run);
		const failed = rows.find((r) => r.framework === "tester-army");
		expect(failed?.status).toBe("failed");
		expect(failed?.version).toBe("0.20.0");
		expect(failed?.suiteMedianMs).toBeUndefined();
		const unsupported = rows.find((r) => r.framework === "detox");
		expect(unsupported?.version).toBeUndefined();
	});
	test("residue counts and footprint", () => {
		const maestro = summaryRows(run).find((r) => r.framework === "maestro");
		expect(maestro?.residue).toEqual({ processes: 2, driverApps: 1, paths: 1 });
		expect(maestro?.footprint?.loc).toBe(336);
	});
});

describe("perTestMatrix", () => {
	const matrix = perTestMatrix(run, manifest);
	test("8 rows with manifest titles, 6 framework columns", () => {
		expect(matrix.rows).toHaveLength(8);
		expect(matrix.frameworks).toHaveLength(6);
		expect(matrix.rows[0]?.title).toBe("onboarding steps through to sign-in");
	});
	test("fastest per row is warden; failed and unsupported have no cell", () => {
		for (const row of matrix.rows) {
			expect(row.cells.warden?.fastest).toBe(true);
			expect(row.cells.maestro?.fastest).toBe(false);
			expect(row.cells["tester-army"]).toBeUndefined();
			expect(row.cells.detox).toBeUndefined();
		}
	});
});

describe("failing frameworks are never fastest", () => {
	test("a faster but failing cell is flagged, not fastest", () => {
		const bad = structuredClone(run);
		const fw = bad.frameworks.find((f) => f.framework === "maestro");
		if (fw?.status !== "ok") throw new Error("sample changed");
		fw.stats.passRate = 0.9;
		const t = fw.stats.perTest["sign-in/field-errors"];
		if (!t) throw new Error("sample changed");
		t.passRate = 0.66;
		t.median = 100;
		t.ratioToFastest = 0.02;
		const row = perTestMatrix(bad, manifest).rows.find((r) => r.id === "sign-in/field-errors");
		expect(row?.cells.maestro).toMatchObject({ fastest: false, failing: true });
		expect(summaryRows(bad).find((r) => r.framework === "maestro")?.failing).toBe(true);
	});
});

describe("untracedRows", () => {
	test("only frameworks that report untracedMs get a row", () => {
		expect(untracedRows(run).map((r) => r.framework)).toEqual(["warden"]);
	});

	test("per rep: the median over warm reps of the summed untraced time, and its share of the test time", () => {
		const [row] = untracedRows(run);
		const warden = run.frameworks.find((f) => f.framework === "warden");
		if (warden?.status !== "ok") throw new Error("sample has no warden");
		const warm = warden.reps.filter((rep) => !rep.cold);
		const sums = warm.map((rep) => rep.tests.reduce((acc, t) => acc + (t.untracedMs ?? 0), 0));
		const wall = warm.map((rep) => rep.tests.reduce((acc, t) => acc + (t.durationMs ?? 0), 0));
		expect(row?.perRepMs).toBeCloseTo(median(sums), 5);
		expect(row?.share).toBeCloseTo(median(sums) / median(wall), 3);
	});

	test("names the test with the most untraced time", () => {
		const [row] = untracedRows(run);
		expect(row?.worst?.id).toBe("todo-detail/open-toggle-delete");
		expect(row?.worst?.ms).toBeGreaterThan(0);
	});

	test("with only a cold rep that rep is used", () => {
		const cold = structuredClone(run);
		const warden = cold.frameworks.find((f) => f.framework === "warden");
		if (warden?.status !== "ok") throw new Error("sample has no warden");
		warden.reps = warden.reps.slice(0, 1);
		expect(untracedRows(cold)[0]?.perRepMs).toBeGreaterThan(0);
	});

	test("a run where nothing reports it has no rows", () => {
		const bare = structuredClone(run);
		for (const f of bare.frameworks) {
			if (f.status !== "ok") continue;
			for (const rep of f.reps) for (const t of rep.tests) delete t.untracedMs;
		}
		expect(untracedRows(bare)).toEqual([]);
	});
});
