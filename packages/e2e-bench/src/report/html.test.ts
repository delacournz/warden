import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadManifest } from "../results/manifest";
import { benchRunSchema } from "../results/schema";
import { escapeHtml } from "./escape";
import { buildSampleRun } from "./fixtures/make-sample";
import { goldenText } from "./golden";
import { renderHtml } from "./html";
import { FAIRNESS_RULES } from "./markdown";

const manifest = loadManifest(join(import.meta.dir, "../.."));
const run = buildSampleRun();
const html = renderHtml(run, manifest);
const count = (needle: string): number => html.split(needle).length - 1;

describe("escapeHtml", () => {
	test("escapes the five special characters", () => {
		expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
	});
});

describe("renderHtml", () => {
	test("is a complete titled document with every framework and the fairness rules", () => {
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).toContain("<title>e2e framework benchmark — ios 2026-10-16</title>");
		for (const f of run.frameworks) expect(html).toContain(f.framework);
		for (const rule of FAIRNESS_RULES)
			expect(html).toContain(escapeHtml(rule.split("`").sort((a, b) => b.length - a.length)[0] ?? ""));
		expect(html).toContain("<h2>Fairness rules</h2>");
		expect(html).toContain("<strong>61.41 s</strong>");
	});
	test("inline JSON parses back and validates", () => {
		const m = /<script type="application\/json" id="bench-results">([\s\S]*?)<\/script>/.exec(html);
		expect(m).not.toBeNull();
		const parsed = benchRunSchema.parse(JSON.parse(m?.[1] ?? ""));
		expect(parsed).toEqual(JSON.parse(JSON.stringify(run)));
	});
	test("self-contained: no network references, no external scripts, styles or fonts", () => {
		expect(html).not.toMatch(/https?:\/\//);
		expect(html).not.toMatch(/<link\b/i);
		expect(html).not.toMatch(/<script[^>]*\ssrc=/i);
		expect(html).not.toMatch(/@import|url\(/);
	});
	test("theme tokens for light and dark", () => {
		expect(html).toContain("@media (prefers-color-scheme: dark)");
		expect(html).toContain(':root[data-theme="dark"]');
		expect(html).toContain('name="viewport"');
	});
	test("every chart is an accessible svg with a title and description", () => {
		expect(count("<svg ")).toBe(count('role="img"'));
		expect(count("<svg ")).toBe(6);
		expect(count("<desc ")).toBe(count("<svg "));
	});
	test("chart geometry for the sample: 4 ok frameworks", () => {
		expect(count('<path class="mark"')).toBe(4 + 8 * 4 + 4 * 4 + 2 * 4);
		const withSteps = run.frameworks.filter((f) => f.status === "ok" && f.stats.stepLatency !== undefined).length;
		expect(withSteps).toBeGreaterThan(0);
		expect(count('<rect class="box"')).toBe(8 * 4 + withSteps);
	});
	test("failed and unsupported frameworks are explained", () => {
		expect(html).toContain("failed in phase <code>run</code>");
		expect(html).toContain("<strong>detox:</strong> unsupported.");
	});
	test("text is escaped", () => {
		const evil = structuredClone(run);
		const first = evil.frameworks[0];
		if (first?.status === "ok") first.residue.processes = ["<script>alert(1)</script>"];
		const out = renderHtml(evil, manifest);
		expect(out).not.toContain("<script>alert(1)");
		expect(out).toContain("&lt;script&gt;alert(1)");
		expect(out.match(/<\/script>/g)?.length).toBe(2);
	});
	test("NaN never reaches the page text and output is stable", () => {
		const nan = structuredClone(run);
		const first = nan.frameworks[0];
		if (first?.status === "ok") first.stats.overheadMs = Number.NaN;
		expect(renderHtml(nan, manifest)).not.toContain(">NaN<");
		expect(renderHtml(run, manifest)).toBe(html);
	});
	test("matches the golden file", () => {
		expect(html).toBe(goldenText(join(import.meta.dir, "fixtures/report.golden.html"), html));
	});
});
