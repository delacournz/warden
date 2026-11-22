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

/**
 * `stdout: "stderr"` keeps the child's stdout off ours (a `--json` command prints exactly one JSON document).
 * `cwd` is where the runner starts: it decides which `node_modules/.bin` `npx` looks in first.
 */
export type RunOpts = { stdout: "inherit" | "stderr"; cwd?: string };

export function realSkillDeps(): SkillDeps {
	return {
		which: (cmd) => Bun.which(cmd),
		runInteractive: (cmd, opts) =>
			Bun.spawn(cmd, {
				stdin: "inherit",
				stdout: opts?.stdout === "stderr" ? 2 : "inherit",
				stderr: "inherit",
				...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
			}).exited,
	};
}

/**
 * The skills CLI `warden skill install` runs, as the runner's package spec: one exact version, so a release always
 * runs the same installer. Bump it by hand after reading the new version's changes.
 */
export const SKILLS_CLI = "skills@1.9.0";

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
		SKILLS_CLI,
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
 * Where the runner starts. A global install runs from warden's own folder (created here), so the package the runner
 * resolves never depends on the directory warden was called from. `--project` installs into the working directory,
 * so it runs there (undefined = inherit).
 */
export function skillsCwd(ctx: CommandContext, opts: SkillsAddOpts): string | undefined {
	if (opts.project) return undefined;
	const root = localSkillRoot(ctx);
	mkdirSync(root, { recursive: true });
	return root;
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
