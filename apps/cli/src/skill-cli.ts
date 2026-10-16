import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { wardenHome } from "@delacour/warden-core/store";
import type { CommandContext } from "./context";
import { SKILL_FILES, SKILL_NAME, SKILL_PATHS } from "./skill";

/** Outside world for installing the skill through the `skills` CLI, injectable for tests. */
export type SkillDeps = {
	which: (cmd: string) => string | null;
	/** run with the terminal attached (the skills CLI may prompt); resolves to its exit code */
	runInteractive: (cmd: string[], opts?: RunOpts) => Promise<number>;
};

/** `stdout: "stderr"` keeps the child's stdout off ours (a `--json` command prints exactly one JSON document). */
export type RunOpts = { stdout: "inherit" | "stderr" };

export function realSkillDeps(): SkillDeps {
	return {
		which: (cmd) => Bun.which(cmd),
		runInteractive: (cmd, opts) =>
			Bun.spawn(cmd, { stdin: "inherit", stdout: opts?.stdout === "stderr" ? 2 : "inherit", stderr: "inherit" }).exited,
	};
}

/** The skills CLI's agent key for Claude Code (`skills add -a claude-code`; installs under `~/.claude/skills`). */
export const CLAUDE_AGENT = "claude-code";

export type SkillsAddOpts = {
	project?: true;
	agent?: string[];
	copy?: true;
	yes?: true;
};

/** `bunx` when bun is installed, else `npx --yes`. */
export function runner(deps: SkillDeps): string[] | undefined {
	if (deps.which("bunx")) return ["bunx"];
	if (deps.which("npx")) return ["npx", "--yes"];
	return undefined;
}

export function skillsAddArgs(source: string, opts: SkillsAddOpts): string[] {
	return [
		"skills",
		"add",
		source,
		"--skill",
		SKILL_NAME,
		...(opts.project ? [] : ["-g"]),
		...(opts.agent ?? []).flatMap((a) => ["-a", a]),
		...(opts.copy ? ["--copy"] : []),
		...(opts.yes ? ["-y"] : []),
	];
}

/** Stable dir holding this binary's skill copy — the skills CLI may symlink to it, so it must outlive the call. */
export function localSkillRoot(ctx: CommandContext): string {
	return join(wardenHome(ctx.env), "skill");
}

/**
 * Stage the embedded skill folder at `<root>/warden`. warden owns this dir: it is recreated from scratch
 * so files dropped from the skill vanish. Returns the root to pass to `skills add`.
 */
export function stageSkillFolder(ctx: CommandContext): string {
	const root = localSkillRoot(ctx);
	const dir = join(root, SKILL_NAME);
	rmSync(dir, { recursive: true, force: true });
	for (const path of SKILL_PATHS) {
		const file = join(dir, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, SKILL_FILES[path]);
	}
	return root;
}
