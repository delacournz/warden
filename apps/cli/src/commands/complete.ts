import { CliCommand, type CommandNode, programRunner } from "../command";
import { completionHelpers } from "../completion";
import type { CommandContext } from "../context";
import { COMMANDS } from "./registry";

export class CompleteCommand extends CliCommand {
	override readonly name = "__complete";
	override readonly summary =
		"list completions for a partial command line (internal; used by `warden completion` scripts)";
	override readonly hidden = true;

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		cmd
			.argument("[words...]", "the words after `warden`, the last one being completed")
			.helpOption(false)
			.allowUnknownOption()
			.action(async (words) => done(await this.runComplete(ctx, words)));
	}

	/** `warden __complete -- <words…>`: what the shell scripts ask on every tab. Loads every command, like `--help`. */
	private async runComplete(ctx: CommandContext, words: string[]): Promise<number> {
		const commands = await Promise.all(COMMANDS.map((entry) => entry.load()));
		const program = programRunner.build(commands, [], ctx);
		for (const line of completionHelpers.formatCompletion(
			completionHelpers.complete(program, words.length > 0 ? words : [""])
		))
			ctx.out(line);
		return 0;
	}
}

export const completeCommand = new CompleteCommand().definition();
