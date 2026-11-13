import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import a11yMd from "../../../skills/warden/references/a11y.md" with { type: "text" };
import authoringMd from "../../../skills/warden/references/authoring.md" with { type: "text" };
import perfMd from "../../../skills/warden/references/perf.md" with { type: "text" };
import physicalMd from "../../../skills/warden/references/physical.md" with { type: "text" };
import specsMd from "../../../skills/warden/references/specs.md" with { type: "text" };
import suitesMd from "../../../skills/warden/references/suites.md" with { type: "text" };
import troubleshootingMd from "../../../skills/warden/references/troubleshooting.md" with { type: "text" };
import uiMd from "../../../skills/warden/references/ui.md" with { type: "text" };
import ruleMd from "../../../skills/warden/rules/warden.md" with { type: "text" };
import skillMd from "../../../skills/warden/SKILL.md" with { type: "text" };

/**
 * The warden agent skill folder. Source of truth: `skills/warden/` at the repo root (so
 * `skills add delacournz/warden` finds it); embedded here by `bun build --compile`.
 */
export const SKILL_NAME = "warden";

export const SKILL_PATHS = [
	"SKILL.md",
	"references/ui.md",
	"references/a11y.md",
	"references/perf.md",
	"references/physical.md",
	"references/specs.md",
	"references/authoring.md",
	"references/suites.md",
	"references/troubleshooting.md",
] as const;
export type SkillPath = (typeof SKILL_PATHS)[number];

export const SKILL_FILES: Readonly<Record<SkillPath, string>> = {
	"SKILL.md": skillMd,
	"references/ui.md": uiMd,
	"references/a11y.md": a11yMd,
	"references/perf.md": perfMd,
	"references/physical.md": physicalMd,
	"references/specs.md": specsMd,
	"references/authoring.md": authoringMd,
	"references/suites.md": suitesMd,
	"references/troubleshooting.md": troubleshootingMd,
};

export const SKILL_MD: string = SKILL_FILES["SKILL.md"];

/** The always-loaded rule, installed as `~/.claude/rules/warden.md` (not part of the skill folder install). */
export const RULE_PATH = "rules/warden.md";
export const RULE_MD: string = ruleMd;

/** An embedded file by its path inside `skills/warden/` (`SKILL.md`, `references/ui.md`, `rules/warden.md`). */
export function embeddedFile(name: string): string | undefined {
	if (name === RULE_PATH) return RULE_MD;
	for (const path of SKILL_PATHS) if (path === name) return SKILL_FILES[path];
	return undefined;
}

/** Skill files under `dir` that are absent or differ from the embedded copy (shared by install + doctor). */
export function staleSkillFiles(dir: string): { missing: SkillPath[]; outdated: SkillPath[] } {
	const missing: SkillPath[] = [];
	const outdated: SkillPath[] = [];
	for (const path of SKILL_PATHS) {
		const file = join(dir, path);
		if (!existsSync(file)) missing.push(path);
		else if (readFileSync(file, "utf8") !== SKILL_FILES[path]) outdated.push(path);
	}
	return { missing, outdated };
}
