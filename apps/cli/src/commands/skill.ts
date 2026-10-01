import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Option } from "@commander-js/extra-typings";
import { wardenHome } from "@delacour/warden-core/store";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { SKILL_MD, SKILL_NAME } from "../skill";
import { releaseRepo } from "../update/release";

/** Outside world for `warden skill`, injectable for tests. */
export type SkillDeps = {
	which: (cmd: string) => string | null;
	/** run with the terminal attached (the skills CLI may prompt); resolves to its exit code */
	runInteractive: (cmd: string[]) => Promise<number>;
};

const SOURCES = ["local", "github"] as const;
type Source = (typeof SOURCES)[number];

export type SkillInstallOpts = {
	from: Source;
	project?: true;
	agent?: string[];
	copy?: true;
	yes?: true;
	dryRun?: true;
	json?: true;
};

/** `bunx` when bun is installed, else `npx --yes`. */
function runner(deps: SkillDeps): string[] | undefined {
	if (deps.which("bunx")) return ["bunx"];
	if (deps.which("npx")) return ["npx", "--yes"];
	return undefined;
}

/** Stable dir holding this binary's skill copy — the skills CLI may symlink to it, so it must outlive the call. */
function localSkillRoot(ctx: CommandContext): string {
	return join(wardenHome(ctx.env), "skill");
}

export function skillsAddArgs(source: string, opts: Omit<SkillInstallOpts, "from">): string[] {
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

/** Raw SKILL.md on stdout, never coloured — made to be piped (`warden skill show | pbcopy`). */
function show(ctx: CommandContext, json: boolean): number {
	emit(ctx, json, { name: SKILL_NAME, content: SKILL_MD }, SKILL_MD.trimEnd());
	return 0;
}

async function install(ctx: CommandContext, deps: SkillDeps, opts: SkillInstallOpts): Promise<number> {
	const { color } = ctx.ui;
	const prefix = runner(deps);
	if (!prefix) {
		ctx.err(
			color.red(
				"warden skill: neither bunx nor npx found — install bun or node, or copy it by hand: `warden skill show`"
			)
		);
		return 1;
	}
	const source: Record<Source, string> = { local: localSkillRoot(ctx), github: releaseRepo(ctx.env) };
	const cmd = [...prefix, ...skillsAddArgs(source[opts.from], opts)];
	if (opts.dryRun) {
		emit(ctx, opts.json === true, { command: cmd }, cmd.join(" "));
		return 0;
	}
	if (opts.from === "local") {
		const dir = join(source.local, SKILL_NAME);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), SKILL_MD);
	}
	ctx.err(color.dim(`warden skill: ${cmd.join(" ")}`));
	return deps.runInteractive(cmd);
}

/** Show or install the warden agent skill. */
export function createSkillCommand(deps: SkillDeps): Command {
	return defineCommand({
		name: "skill",
		summary: "the warden agent skill: show (copy/paste) | install (bunx/npx skills add)",
		register: (cmd, ctx, done) => {
			cmd
				.command("show")
				.description("print SKILL.md to copy/paste (e.g. `warden skill show | pbcopy`)")
				.option("--json", "machine-readable output")
				.action((opts) => done(show(ctx, opts.json === true)));
			cmd
				.command("install")
				.description("install via `bunx skills add` (npx fallback)")
				.addOption(
					new Option("--from <source>", "local = this binary's embedded copy; github = the release repo (updatable)")
						.choices(SOURCES)
						.default("local" as const)
				)
				.option("--project", "install into the current project (default: global, -g)")
				.option("-a, --agent <agent...>", "target agent(s), repeatable (default: the skills CLI asks)")
				.option("--copy", "copy files instead of symlinking")
				.option("-y, --yes", "skip the skills CLI's confirmations")
				.option("--dry-run", "print the skills command, run nothing")
				.option("--json", "machine-readable output (with --dry-run: the command as JSON)")
				.action(async (opts) => done(await install(ctx, deps, opts)));
		},
	});
}
export const skillCommand: Command = createSkillCommand({
	which: (cmd) => Bun.which(cmd),
	runInteractive: (cmd) => Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited,
});
