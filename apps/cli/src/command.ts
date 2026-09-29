import { Command as Commander, CommanderError } from "@commander-js/extra-typings";
import type { CommandContext } from "./context";

/**
 * Wire a command onto its commander node: arguments, options, nested subcommands and actions.
 * Actions report their exit code through `done` (commander actions can't return one).
 */
export type Register = (cmd: Commander, ctx: CommandContext, done: (code: number) => void) => void;

export type Command = {
	name: string;
	aliases?: readonly string[];
	summary: string;
	register: Register;
	/** parse `ctx.argv` as this command's arguments and run it (what tests call) */
	run: (ctx: CommandContext) => Promise<number>;
};

export const PROGRAM_DESCRIPTION = "machine-wide device + port leasing for agents and users";

export function defineCommand(def: Omit<Command, "run">): Command {
	const command: Command = { ...def, run: (ctx) => runProgram([command], [def.name, ...ctx.argv], ctx) };
	return command;
}

/** Trailing newline off: ctx.out/err add their own. */
const chomp = (text: string) => text.replace(/\n$/, "");

/**
 * Build a fresh commander program (option values persist on a program between parses) with
 * `commands`, parse `argv`, run the matching action. Help → 0; usage errors → 1 (commander has
 * already printed them, in red, to ctx.err); otherwise the action's exit code.
 */
export async function runProgram(commands: readonly Command[], argv: string[], ctx: CommandContext): Promise<number> {
	const program = new Commander("warden")
		.description(PROGRAM_DESCRIPTION)
		.exitOverride()
		.enablePositionalOptions()
		.configureOutput({
			writeOut: (text) => ctx.out(chomp(text)),
			writeErr: (text) => ctx.err(chomp(text)),
			outputError: (text, write) => write(ctx.ui.color.red(text)),
		})
		.showHelpAfterError(ctx.ui.color.dim("(add --help for usage)"));
	let code = 0;
	for (const command of commands) {
		const sub = program.command(command.name).description(command.summary);
		for (const alias of command.aliases ?? []) sub.alias(alias);
		command.register(sub, ctx, (n) => {
			code = n;
		});
	}
	try {
		await program.parseAsync(argv, { from: "user" });
	} catch (error) {
		if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 1;
		throw error;
	}
	return code;
}
