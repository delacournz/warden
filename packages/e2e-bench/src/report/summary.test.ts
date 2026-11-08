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
	test("ok frameworks with steps carry stepGroups, others omit the field", () => {
		const warden = summary.frameworks.find((f) => f.framework === "warden");
		if (warden?.status !== "ok") throw new Error("expected ok");
		expect(warden.stepGroups?.[0]?.kind).toBe("verb");
		expect(warden.stepGroups?.reduce((a, g) => a + g.share, 0)).toBeCloseTo(1, 1);
		const argent = summary.frameworks.find((f) => f.framework === "argent");
		if (argent?.status !== "ok") throw new Error("expected ok");
		expect("stepGroups" in argent).toBe(false);
	});
	test("a summary written before stepGroups still parses", () => {
		const old = JSON.parse(JSON.stringify(summary));
		for (const f of old.frameworks) delete f.stepGroups;
		expect(benchSummarySchema.safeParse(old).success).toBe(true);
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

describe("benchSummarySchema and retired frameworks", () => {
	test("still reads a published summary that carries a maestro or detox row", () => {
		const summary = benchSummary(run, manifest);
		const retired = {
			...summary,
			frameworks: [
				...summary.frameworks,
				{ framework: "maestro", status: "unsupported", version: "2.0.0", reason: "removed 2026-10-24" },
				{ framework: "detox", status: "failed", version: "20.51.3", phase: "run", error: "RN 0.86 unsupported" },
			],
		};
		expect(benchSummarySchema.safeParse(retired).success).toBe(true);
		expect(
			benchSummarySchema.safeParse({ ...summary, frameworks: [{ ...summary.frameworks[0], framework: "appium" }] })
				.success
		).toBe(false);
	});
});
