import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { wardenHome } from "@warden/core/store";
import type { Command, CommandContext } from "../context";
import { emit } from "../output";
import { SKILL_MD, SKILL_NAME } from "../skill";
import { releaseRepo } from "../update/release";

const USAGE = [
	"warden skill show [--json]                       print SKILL.md to copy/paste (e.g. `warden skill show | pbcopy`)",
	"warden skill install [--from local|github] [--project] [--agent <a>…] [--copy] [--yes] [--dry-run]",
	"                                                 install via `bunx skills add` (npx fallback); default --from local = this binary's copy",
].join("\n");

/** Outside world for `warden skill`, injectable for tests. */
export type SkillDeps = {
	which: (cmd: string) => string | null;
	/** run with the terminal attached (the skills CLI may prompt); resolves to its exit code */
	runInteractive: (cmd: string[]) => Promise<number>;
};

type Source = "local" | "github";

function parse(argv: string[]) {
	return parseArgs({
		args: argv,
		options: {
			from: { type: "string", default: "local" },
			project: { type: "boolean" },
			agent: { type: "string", multiple: true, short: "a" },
			copy: { type: "boolean" },
			yes: { type: "boolean", short: "y" },
			"dry-run": { type: "boolean" },
			json: { type: "boolean" },
		},
		allowPositionals: true,
		strict: true,
	});
}

type Values = ReturnType<typeof parse>["values"];

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

export function skillsAddArgs(source: string, values: Values): string[] {
	return [
		"skills",
		"add",
		source,
		"--skill",
		SKILL_NAME,
		...(values.project ? [] : ["-g"]),
		...(values.agent ?? []).flatMap((a) => ["-a", a]),
		...(values.copy ? ["--copy"] : []),
		...(values.yes ? ["-y"] : []),
	];
}

async function install(ctx: CommandContext, deps: SkillDeps, values: Values): Promise<number> {
	const from = values.from;
	if (from !== "local" && from !== "github") {
		ctx.err(`warden skill: --from must be local or github, got "${from}"\n${USAGE}`);
		return 1;
	}
	const prefix = runner(deps);
	if (!prefix) {
		ctx.err("warden skill: neither bunx nor npx found — install bun or node, or copy it by hand: `warden skill show`");
		return 1;
	}
	const source: Record<Source, string> = { local: localSkillRoot(ctx), github: releaseRepo(ctx.env) };
	const cmd = [...prefix, ...skillsAddArgs(source[from], values)];
	if (values["dry-run"]) {
		ctx.out(cmd.join(" "));
		return 0;
	}
	if (from === "local") {
		const dir = join(source.local, SKILL_NAME);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), SKILL_MD);
	}
	ctx.err(`warden skill: ${cmd.join(" ")}`);
	return deps.runInteractive(cmd);
}

/** Show or install the warden agent skill. */
export function createSkillCommand(deps: SkillDeps): Command {
	async function run(ctx: CommandContext): Promise<number> {
		let parsed: ReturnType<typeof parse>;
		try {
			parsed = parse(ctx.argv);
		} catch (error) {
			ctx.err(`warden skill: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
			return 1;
		}
		switch (parsed.positionals[0]) {
			case "show":
				emit(ctx, parsed.values.json === true, { name: SKILL_NAME, content: SKILL_MD }, SKILL_MD.trimEnd());
				return 0;
			case "install":
				return install(ctx, deps, parsed.values);
			default:
				ctx.err(`warden skill: expected show | install\n${USAGE}`);
				return 1;
		}
	}
	return {
		name: "skill",
		summary: "the warden agent skill: show (copy/paste) | install (bunx/npx skills add)",
		usage: USAGE,
		run,
	};
}

export const skillCommand: Command = createSkillCommand({
	which: (cmd) => Bun.which(cmd),
	runInteractive: (cmd) => Bun.spawn(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited,
});
