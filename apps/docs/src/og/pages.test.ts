import { describe, expect, test } from "bun:test";
import { cardProof, clamp, PROOF_LINES, parseFrontmatter, sectionOf, slugsForFile } from "./pages";

describe("parseFrontmatter", () => {
	test("reads the leading block", () => {
		const mdx = "---\ntitle: Agents\ndescription: Hooks that lease devices: one per session.\nicon: Bot\n---\n\nBody\n";
		expect(parseFrontmatter(mdx)).toEqual({
			title: "Agents",
			description: "Hooks that lease devices: one per session.",
			icon: "Bot",
		});
	});

	test("strips matching quotes", () => {
		expect(parseFrontmatter(`---\ntitle: "warden.config.ts"\n---\n`)).toEqual({ title: "warden.config.ts" });
	});

	test("no block is no fields", () => {
		expect(parseFrontmatter("# Heading\n\ntitle: not frontmatter\n")).toEqual({});
	});

	test("a rule later in the body is not frontmatter", () => {
		expect(parseFrontmatter("---\ntitle: A\n---\n\n---\ntitle: B\n---\n")).toEqual({ title: "A" });
	});
});

describe("slugsForFile", () => {
	test("root index is the docs root", () => {
		expect(slugsForFile("index.mdx")).toEqual([]);
	});

	test("nested page", () => {
		expect(slugsForFile("guides/agents.mdx")).toEqual(["guides", "agents"]);
	});

	test("folder index takes the folder's slug", () => {
		expect(slugsForFile("reference/index.mdx")).toEqual(["reference"]);
	});
});

describe("clamp", () => {
	test("short text is untouched", () => {
		expect(clamp("Ports", 20)).toBe("Ports");
	});

	test("cuts at a word boundary and drops trailing punctuation", () => {
		expect(clamp("Claim devices and ports, released on exit.", 26)).toBe("Claim devices and ports…");
	});
});

describe("cardProof", () => {
	test("a shell block keeps its commands, without comments or blank lines", () => {
		const mdx = [
			"---",
			"title: UI",
			"---",
			"",
			"```bash",
			"# lease first",
			"warden claim ios --json                # keep the udid",
			"",
			"warden ui open com.example.app --udid $UDID",
			"```",
			"",
			"```ts",
			"later();",
			"```",
		].join("\n");
		expect(cardProof(mdx)).toEqual({
			kind: "shell",
			lines: ["warden claim ios --json", "warden ui open com.example.app --udid $UDID"],
		});
	});

	test("another language is shown as written, dedented, tabs as two spaces", () => {
		const mdx = '<Tab>\n  ```ts title="a.e2e.ts"\n  test("x", () => {\n  \tgo();\n  });\n  ```\n</Tab>\n';
		expect(cardProof(mdx)).toEqual({ kind: "code", lang: "ts", lines: ['test("x", () => {', "  go();", "});"] });
	});

	test("a long block is cut", () => {
		const body = Array.from({ length: 20 }, (_, i) => `warden run ${i}`).join("\n");
		const proof = cardProof(`\`\`\`bash\n${body}\n\`\`\`\n`);
		expect(proof.kind === "shell" && proof.lines.length).toBe(PROOF_LINES);
	});

	test("a one-line install gives way to the first block with more to show", () => {
		const mdx = "```bash\nbun add -d x\n```\n\n```ts\na();\nb();\nc();\n```\n";
		expect(cardProof(mdx)).toEqual({ kind: "code", lang: "ts", lines: ["a();", "b();", "c();"] });
	});

	test("only short blocks: the first one", () => {
		expect(cardProof("```bash\nbun add -d x\n```\n\n```bash\ny\n```\n")).toEqual({
			kind: "shell",
			lines: ["bun add -d x"],
		});
	});

	test("no code block is the page's outline, subsections indented", () => {
		const mdx = "Intro\n\n## Run it `now`\n\ntext\n\n### Deeper\n\n#### Deepest\n\n## [Results](#r)\n";
		expect(cardProof(mdx)).toEqual({ kind: "outline", headings: ["Run it now", "  Deeper", "Results"] });
	});
});

describe("sectionOf", () => {
	const metas = {
		"": { pages: ["---Get started---", "index", "quickstart", "---Project---", "updating", "...agents"] },
		agents: { title: "Agents drive devices" },
	};

	test("a folder page is its folder's title", () => {
		expect(sectionOf(["agents", "ui"], metas)).toBe("Agents drive devices");
	});

	test("a folder index is its folder's title", () => {
		expect(sectionOf(["agents"], metas)).toBe("Agents drive devices");
	});

	test("a root page is the separator above it", () => {
		expect(sectionOf(["updating"], metas)).toBe("Project");
		expect(sectionOf([], metas)).toBe("Get started");
	});

	test("an unlisted page has none", () => {
		expect(sectionOf(["nowhere"], metas)).toBeUndefined();
	});
});
