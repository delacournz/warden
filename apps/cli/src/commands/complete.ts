import { buildProgram, defineCommand } from "../command";
import { complete, formatCompletion } from "../completion";
import type { CommandContext } from "../context";
import { COMMANDS } from "./registry";

/** `warden __complete -- <words…>`: what the shell scripts ask on every tab. Loads every command, like `--help`. */
async function runComplete(ctx: CommandContext, words: string[]): Promise<number> {
	const commands = await Promise.all(COMMANDS.map((entry) => entry.load()));
	const program = buildProgram(commands, [], ctx);
	for (const line of formatCompletion(complete(program, words.length > 0 ? words : [""]))) ctx.out(line);
	return 0;
}

export const completeCommand = defineCommand({
	name: "__complete",
	summary: "list completions for a partial command line (internal; used by `warden completion` scripts)",
	hidden: true,
	register: (cmd, ctx, done) => {
		cmd
			.argument("[words...]", "the words after `warden`, the last one being completed")
			.helpOption(false)
			.allowUnknownOption()
			.action(async (words) => done(await runComplete(ctx, words)));
	},
});
