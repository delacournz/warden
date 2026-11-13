import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEVICE_CONTROL } from "./landing.data";
import { demosAsMarkdown, llmsIndex } from "./llms";

const CONTENT = join(import.meta.dirname, "..", "..", "content", "docs");

function mdxUnder(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return mdxUnder(path);
		return path.endsWith(".mdx") ? [path] : [];
	});
}

const fumadocsIndex =
	"# warden\n\n- Getting Started: Install warden\n  - [Quickstart](/docs/getting-started/quickstart): Install.\n";

describe("llmsIndex", () => {
	const out = llmsIndex(fumadocsIndex);

	test("opens with the llmstxt.org H1 and a blockquote summary", () => {
		const [h1, blank, quote] = out.split("\n");
		expect(h1).toBe("# warden");
		expect(blank).toBe("");
		expect(quote?.startsWith("> ")).toBe(true);
	});

	test("names both npm packages and the commands an agent starts with", () => {
		for (const text of [
			"@delacour/warden",
			"@delacour/warden-e2e",
			"warden install",
			"warden skill show",
			"warden claim ios --json",
			"warden ui snapshot -i",
			"warden ui close --release",
			"warden e2e <suite>",
		]) {
			expect(out).toContain(text);
		}
	});

	test("keeps the page index once, under a Docs heading, without its own H1", () => {
		expect(out).toContain("## Docs\n\n- Getting Started: Install warden");
		expect(out.match(/^# warden$/gm)).toHaveLength(1);
	});

	test("states the key facts and where the code and packages live", () => {
		expect(out).toContain("## Key facts");
		expect(out).toContain("MIT");
		expect(out).toContain("## Links");
		expect(out).toContain("https://github.com/delacournz/warden");
		expect(out).toContain("https://www.npmjs.com/package/@delacour/warden-e2e");
	});
});

describe("demosAsMarkdown", () => {
	const clips = [
		{ id: "network", title: "Pull the plug.", src: "/demos/network/offline" },
		{ id: "a11y", title: "Audit a screen.", src: "/demos/a11y/audit" },
	] as const;

	test("a <DemoClip> becomes a link to its mp4, never the extensionless path", () => {
		const out = demosAsMarkdown('Intro\n\n<DemoClip src="/demos/a11y/audit" label="an audit" />\n\nAfter', clips);
		expect(out).toBe("Intro\n\n[Video: an audit](https://warden.co.nz/demos/a11y/audit.mp4)\n\nAfter");
	});

	test("a <DemoReel> keeps its facts beside the link", () => {
		const out = demosAsMarkdown(
			'<DemoReel src="/demos/e2e/batch" label="a batch" command="warden batch x" facts="37/37 passed" />',
			clips
		);
		expect(out).toBe("[Video: a batch](https://warden.co.nz/demos/e2e/batch.mp4) (`warden batch x`: 37/37 passed)");
	});

	test("<DemoTabs> lists each clip it shows, in the order given, with HTML-escaped ids decoded", () => {
		const out = demosAsMarkdown('<DemoTabs ids="[&#x22;a11y&#x22;, &#x22;network&#x22;, &#x22;gone&#x22;]" />', clips);
		expect(out).toBe(
			"- [Video: Audit a screen.](https://warden.co.nz/demos/a11y/audit.mp4)\n- [Video: Pull the plug.](https://warden.co.nz/demos/network/offline.mp4)"
		);
	});

	test("leaves no extensionless /demos/ path in any docs page's Markdown", () => {
		const left = mdxUnder(CONTENT).flatMap((file) => {
			const out = demosAsMarkdown(readFileSync(file, "utf-8"), DEVICE_CONTROL.clips);
			return (out.match(/\/demos\/[a-z0-9-]+\/[a-z0-9-]+(?![a-z0-9.-])/g) ?? []).map((m) => `${file}: ${m}`);
		});
		expect(left).toEqual([]);
	});
});
