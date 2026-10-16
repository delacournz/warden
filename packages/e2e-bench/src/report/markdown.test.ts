import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadManifest } from "../results/manifest";
import { benchRunSchema } from "../results/schema";
import { buildSampleRun } from "./fixtures/make-sample";
import { goldenText } from "./golden";
import { renderMarkdown } from "./markdown";

const manifest = loadManifest(join(import.meta.dir, "../.."));
const run = buildSampleRun();

describe("sample fixture", () => {
	test("committed JSON validates and matches the generator", () => {
		const text = readFileSync(join(import.meta.dir, "fixtures/bench-results.sample.json"), "utf8");
		const parsed = benchRunSchema.parse(JSON.parse(text));
		expect(parsed).toEqual(JSON.parse(JSON.stringify(run)));
		expect(parsed.frameworks.map((f) => f.status)).toEqual(["ok", "ok", "ok", "ok", "failed", "unsupported"]);
	});
});

describe("renderMarkdown", () => {
	const md = renderMarkdown(run, manifest);
	test("matches the golden file", () => {
		expect(md).toBe(goldenText(join(import.meta.dir, "fixtures/report.golden.md"), md));
	});
	test("title, fairness rules and bold fastest", () => {
		expect(md.startsWith("# e2e framework benchmark — ios 2026-10-16\n")).toBe(true);
		expect(md).toContain("## Fairness rules");
		expect(md).toContain("| warden | ok | 0.19.0 | **61.41 s** |");
	});
	test("failed and unsupported frameworks are explained, missing cells are dashes", () => {
		expect(md).toContain("failed in phase `run`. parity breach");
		expect(md).toContain("**detox:** unsupported.");
	});
	test("untraced time: a section for frameworks whose trace reports it, none otherwise", () => {
		expect(md).toContain("## Untraced time");
		expect(md).toMatch(/\| warden \| [\d.]+ s \| [\d.]+% \| todo-detail\/open-toggle-delete/);
		const bare = structuredClone(run);
		for (const f of bare.frameworks) {
			if (f.status !== "ok") continue;
			for (const rep of f.reps) for (const t of rep.tests) delete t.untracedMs;
		}
		expect(renderMarkdown(bare, manifest)).not.toContain("Untraced");
	});
	test("NaN renders as a dash and the output is pure", () => {
		const nan = structuredClone(run);
		const first = nan.frameworks[0];
		if (first?.status === "ok") first.stats.overheadMs = Number.NaN;
		expect(renderMarkdown(nan, manifest)).not.toContain("NaN");
		expect(renderMarkdown(run, manifest)).toBe(md);
	});
});
