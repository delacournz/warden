import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadManifest } from "../results/manifest";
import { buildSampleRun, withRepCpu } from "./fixtures/make-sample";
import { benchSummary, benchSummarySchema } from "./summary";

const manifest = loadManifest(join(import.meta.dir, "../.."));
const run = buildSampleRun();

describe("benchSummary", () => {
	const summary = benchSummary(run, manifest);

	test("validates against its own schema and survives a JSON round trip", () => {
		expect(benchSummarySchema.safeParse(JSON.parse(JSON.stringify(summary))).success).toBe(true);
	});
	test("one framework entry per framework in run order, non-ok rows keep their reason or error", () => {
		expect(summary.frameworks.map((f) => f.framework)).toEqual(run.frameworks.map((f) => f.framework));
		const failed = summary.frameworks.find((f) => f.status === "failed");
		expect(failed?.status === "failed" && failed.error.length).toBeLessThanOrEqual(301);
	});
	test("exactly one fastest framework, marked like the report table", () => {
		const fastest = summary.frameworks.flatMap((f) => (f.status === "ok" && f.fastest ? [f.framework] : []));
		expect(fastest).toEqual(["warden"]);
	});
	test("8 tests with titles and cells only for ok frameworks", () => {
		expect(summary.tests).toHaveLength(8);
		const first = summary.tests[0];
		expect(first?.title).toBe(manifest.tests["onboarding/steps-to-sign-in"]?.title ?? "");
		const okIds = summary.frameworks.flatMap((f) => (f.status === "ok" ? [f.framework] : []));
		for (const t of summary.tests) {
			for (const id of Object.keys(t.cells)) expect(okIds).toContain(id as (typeof okIds)[number]);
		}
	});
	test("app hashes are shortened and the file stays small", () => {
		expect(summary.app.sha256.length).toBe(12);
		expect(JSON.stringify(summary).length).toBeLessThan(20_000);
	});
	test("is deterministic", () => {
		expect(JSON.stringify(benchSummary(run, manifest))).toBe(JSON.stringify(summary));
	});
});

describe("benchSummary CPU-seconds (19-6)", () => {
	test("ok frameworks carry CPU-seconds per rep and the whole-framework CPU-seconds when the run has them", () => {
		const summary = benchSummary(
			withRepCpu(run, () => 3.456),
			manifest
		);
		expect(benchSummarySchema.safeParse(JSON.parse(JSON.stringify(summary))).success).toBe(true);
		const warden = summary.frameworks.find((f) => f.framework === "warden");
		if (warden?.status !== "ok") throw new Error("expected ok");
		expect(warden.cpuSecondsPerRep).toBe(3.46);
		expect(warden.resources.host.cpuSeconds).toBe(12.37);
	});
	test("older runs keep the old shape", () => {
		const warden = benchSummary(run, manifest).frameworks.find((f) => f.framework === "warden");
		if (warden?.status !== "ok") throw new Error("expected ok");
		expect("cpuSecondsPerRep" in warden).toBe(false);
		expect("cpuSeconds" in warden.resources.host).toBe(false);
	});
});
