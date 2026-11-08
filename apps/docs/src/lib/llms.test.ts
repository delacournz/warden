import { describe, expect, test } from "bun:test";
import { llmsIndex } from "./llms";

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
