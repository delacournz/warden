import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { docsSchema } from "./sidebar-title";
import { simulatorOnlyMarkdown, simulatorOnlyNotice } from "./simulator-only";

const CONTENT = join(import.meta.dirname, "..", "..", "content", "docs");

/** Device conditions run on simulators and emulators only (`physicalConditionOps` refuses them all on a phone). */
const CONDITION_DIRS = ["e2e/conditions", "sims/conditions"];

describe("simulatorOnlyNotice", () => {
	test("names the page's subject and says physical devices are not supported", () => {
		expect(simulatorOnlyNotice("Biometrics")).toBe(
			"Biometrics can only be used against simulators and emulators, physical devices are not supported."
		);
	});
});

describe("simulatorOnlyMarkdown", () => {
	test("a simulator-only page opens its Markdown with the notice as a warning quote", () => {
		expect(simulatorOnlyMarkdown({ title: "Camera", simulatorOnly: true })).toBe(
			"> **Warning:** Camera can only be used against simulators and emulators, physical devices are not supported.\n\n"
		);
	});

	test("any other page gets nothing", () => {
		expect(simulatorOnlyMarkdown({ title: "Ports" })).toBe("");
		expect(simulatorOnlyMarkdown({ title: "Ports", simulatorOnly: false })).toBe("");
	});
});

describe("docsSchema", () => {
	test("keeps simulatorOnly from the frontmatter", () => {
		expect(docsSchema.parse({ title: "Network", simulatorOnly: true }).simulatorOnly).toBe(true);
	});

	test("leaves it unset when the frontmatter has none", () => {
		expect(docsSchema.parse({ title: "Ports" }).simulatorOnly).toBeUndefined();
	});
});

describe("device condition pages", () => {
	const pages = CONDITION_DIRS.flatMap((dir) =>
		readdirSync(join(CONTENT, dir))
			.filter((name) => name.endsWith(".mdx"))
			.map((name) => ({ file: `${dir}/${name}`, text: readFileSync(join(CONTENT, dir, name), "utf-8") }))
	);

	test("there are condition pages to check", () => {
		expect(pages.length).toBeGreaterThan(0);
	});

	test("every condition page sets simulatorOnly: true, so it shows the simulators-only banner", () => {
		expect(pages.filter(({ text }) => !/^simulatorOnly: true$/m.test(text)).map(({ file }) => file)).toEqual([]);
	});
});
