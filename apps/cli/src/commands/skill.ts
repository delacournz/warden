import { Option } from "@commander-js/extra-typings";
import { type Command, defineCommand } from "../command";
import type { CommandContext } from "../context";
import { emit } from "../output";
import { embeddedFile, RULE_PATH, SKILL_FILES, SKILL_MD, SKILL_NAME, SKILL_PATHS } from "../skill";
import {
	localSkillRoot,
	realSkillDeps,
	runner,
	type SkillDeps,
	type SkillsAddOpts,
	skillsAddArgs,
	stageSkillFolder,
} from "../skill-cli";
import { releaseRepo } from "../update/release";

export type { SkillDeps };

const SOURCES = ["local", "github"] as const;
type Source = (typeof SOURCES)[number];

export type SkillInstallOpts = SkillsAddOpts & { from: Source; dryRun?: true; json?: true };

/** Raw SKILL.md (or `--file <path>`) on stdout, never coloured — made to be piped (`warden skill show | pbcopy`). */
function show(ctx: CommandContext, json: boolean, file?: string): number {
	if (file === undefined) {
		emit(ctx, json, { name: SKILL_NAME, content: SKILL_MD, files: SKILL_FILES }, SKILL_MD.trimEnd());
		return 0;
	}
	const content = embeddedFile(file);
	if (content === undefined) {
		ctx.err(
			ctx.ui.color.red(`warden skill: no embedded file ${file} — one of: ${[...SKILL_PATHS, RULE_PATH].join(", ")}`)
		);
		return 1;
	}
	emit(ctx, json, { name: SKILL_NAME, file, content }, content.trimEnd());
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
		stageSkillFolder(ctx);
	}
	ctx.err(color.dim(`warden skill: ${cmd.join(" ")}`));
	return deps.runInteractive(cmd, { stdout: opts.json ? "stderr" : "inherit" });
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
				.option("--file <path>", "print one embedded file (references/ui.md, rules/warden.md, …)")
				.option("--json", "machine-readable output")
				.action((opts) => done(show(ctx, opts.json === true, opts.file)));
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
export const skillCommand: Command = createSkillCommand(realSkillDeps());
