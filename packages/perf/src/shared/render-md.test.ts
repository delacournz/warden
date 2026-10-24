import { describe, expect, test } from "bun:test";
import type { Finding } from "./findings.types";
import { DEV_BUILD_BANNER, type Report, renderMarkdown, SIMULATOR_BANNER } from "./render-md";

const finding = (over: Partial<Finding> & Pick<Finding, "kind">, costMs: number): Finding =>
	({
		severity: "warn",
		costMs,
		evidence: `evidence ${costMs}`,
		fix: `fix ${costMs}`,
		next: [],
		...over,
	}) as Finding;

const report = (over: Partial<Report> = {}): Report => ({
	title: "warden perf report 20261024-101530-a1b2c3",
	banners: [],
	summary: ["device U1 (ios)", "app com.acme.shop"],
	findings: [],
	sections: [],
	next: ["warden perf query <id> commits"],
	...over,
});

describe("renderMarkdown", () => {
	test("writes the title, banners, summary and a trailing next: block", () => {
		const text = renderMarkdown(report({ banners: [SIMULATOR_BANNER] }));
		const lines = text.split("\n");
		expect(lines[0]).toBe("# warden perf report 20261024-101530-a1b2c3");
		expect(text).toContain(`> ${SIMULATOR_BANNER}`);
		expect(text).toContain("device U1 (ios)");
		expect(lines.at(-2)).toBe("next:");
		expect(lines.at(-1)).toBe("  warden perf query <id> commits");
	});

	test("ranks findings by severity, then cost", () => {
		const text = renderMarkdown(
			report({
				findings: [
					finding({ kind: "hang", atMs: 1, severity: "warn" }, 500),
					finding({ kind: "jank", jankPct: 9, severity: "critical" }, 100),
					finding({ kind: "hang", atMs: 2, severity: "warn" }, 900),
				],
			})
		);
		const order = [...text.matchAll(/evidence (\d+)/g)].map((m) => m[1]);
		expect(order).toEqual(["100", "900", "500"]);
	});

	test("caps the body at maxLines but keeps every next: hint", () => {
		const many = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		const text = renderMarkdown(report({ sections: [{ title: "Big", lines: many }], next: ["a", "b", "c"] }), {
			maxLines: 20,
		});
		const lines = text.split("\n");
		expect(lines.length).toBeLessThanOrEqual(20);
		expect(text).toContain("more lines");
		expect(lines.slice(-4)).toEqual(["next:", "  a", "  b", "  c"]);
	});

	test("no cap without maxLines", () => {
		const many = Array.from({ length: 100 }, (_, i) => `line ${i}`);
		const text = renderMarkdown(report({ sections: [{ title: "Big", lines: many }] }));
		expect(text).toContain("line 99");
	});

	test("the dev banner mentions __DEV__", () => {
		expect(DEV_BUILD_BANNER).toContain("__DEV__");
		expect(SIMULATOR_BANNER).toContain("compare relative, not absolute");
	});
});
