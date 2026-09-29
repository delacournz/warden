import skillMarkdown from "../../../skills/warden/SKILL.md" with { type: "text" };

/**
 * The warden agent skill. Source of truth: `skills/warden/SKILL.md` at the repo root (so
 * `skills add delacournz/warden` finds it); embedded here by `bun build --compile`.
 */
export const SKILL_NAME = "warden";
export const SKILL_MD: string = skillMarkdown;
