import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { embeddedFile, RULE_MD, RULE_PATH, SKILL_FILES, SKILL_MD, SKILL_PATHS, staleSkillFiles } from "./skill";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "warden-skill-"));
	dirs.push(d);
	return d;
}

function writeAll(dir: string): void {
	for (const p of SKILL_PATHS) {
		mkdirSync(dirname(join(dir, p)), { recursive: true });
		writeFileSync(join(dir, p), SKILL_FILES[p]);
	}
}

describe("embedded skill folder", () => {
	test("SKILL_PATHS lists the nine files, all non-empty; SKILL.md has frontmatter", () => {
		expect([...SKILL_PATHS]).toEqual([
			"SKILL.md",
			"references/ui.md",
			"references/a11y.md",
			"references/perf.md",
			"references/physical.md",
			"references/specs.md",
			"references/authoring.md",
			"references/suites.md",
			"references/troubleshooting.md",
		]);
		for (const p of SKILL_PATHS) expect(SKILL_FILES[p].trim().length).toBeGreaterThan(0);
		expect(RULE_MD.trim().length).toBeGreaterThan(0);
		expect(SKILL_MD).toStartWith("---\nname: warden\n");
	});

	test("rule and skill gate Xcode 27 MCP DeviceInteraction behind a claimed udid", () => {
		for (const text of [RULE_MD, SKILL_MD]) {
			expect(text).toContain("mcpbridge");
			expect(text).toContain("DeviceInteraction");
			expect(text).toContain("--unsafe-always-allow-all-agents");
		}
	});

	test("every references/*.md link in SKILL.md is embedded", () => {
		const links = new Set(SKILL_MD.match(/references\/[a-z-]+\.md/g) ?? []);
		for (const link of links) expect((SKILL_PATHS as readonly string[]).includes(link)).toBe(true);
	});

	test("paths are relative and stay inside the folder", () => {
		for (const p of SKILL_PATHS) {
			expect(p.startsWith("/")).toBe(false);
			expect(p.includes("..")).toBe(false);
		}
	});

	test("embeddedFile resolves skill files and the rule, else undefined", () => {
		expect(RULE_PATH).toBe("rules/warden.md");
		expect(embeddedFile("references/ui.md")).toBe(SKILL_FILES["references/ui.md"]);
		expect(embeddedFile("rules/warden.md")).toBe(RULE_MD);
		expect(embeddedFile("nope")).toBeUndefined();
	});
});

describe("staleSkillFiles", () => {
	test("empty dir → everything missing", () => {
		expect(staleSkillFiles(tmp())).toEqual({ missing: [...SKILL_PATHS], outdated: [] });
	});

	test("all written → nothing stale; altered file → outdated", () => {
		const dir = tmp();
		writeAll(dir);
		expect(staleSkillFiles(dir)).toEqual({ missing: [], outdated: [] });
		writeFileSync(join(dir, "references/ui.md"), "old");
		expect(staleSkillFiles(dir)).toEqual({ missing: [], outdated: ["references/ui.md"] });
	});
});
