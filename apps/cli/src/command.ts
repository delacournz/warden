import {
	Command as Commander,
	CommanderError,
	type CommandUnknownOpts,
	type HelpConfiguration,
} from "@commander-js/extra-typings";
import type { CommandContext } from "./context";
import { SYMBOLS, type Ui } from "./ui";

/**
 * Wire a command onto its commander node: arguments, options, nested subcommands and actions.
 * Actions report their exit code through `done` (commander actions can't return one).
 */
export type Register = (cmd: Commander, ctx: CommandContext, done: (code: number) => void) => void;

export type Command = {
	name: string;
	aliases?: readonly string[];
	/** heading this command is listed under in `warden --help` */
	group?: CommandGroup;
	summary: string;
	/** left out of `--help` (internal workers) */
	hidden?: true;
	register: Register;
	/** parse `ctx.argv` as this command's arguments and run it (what tests call) */
	run: (ctx: CommandContext) => Promise<number>;
};

/**
 * A command as the registry lists it: everything root `--help` and dispatch need, plus a `load` that imports
 * the command's module only when it is needed. `registry.test.ts` pins each listing to the module it loads.
 */
export type CommandEntry = Pick<Command, "name" | "aliases" | "group" | "summary" | "hidden"> & {
	load: () => Promise<Command>;
};

/** `warden --help` sections, in the order they are shown. */
export const COMMAND_GROUPS = ["Lease", "Run", "Devices", "Builds", "Setup"] as const;
export type CommandGroup = (typeof COMMAND_GROUPS)[number];

export const PROGRAM_DESCRIPTION = "machine-wide device + port leasing for agents and users";

export function defineCommand(def: Omit<Command, "run">): Command {
	const command: Command = { ...def, run: (ctx) => runProgram([command], [def.name, ...ctx.argv], ctx) };
	return command;
}

/** Trailing newline off: ctx.out/err add their own. */
const chomp = (text: string) => text.replace(/\n$/, "");

/** `claim [platform]`: a subcommand's name, aliases and arguments (every command takes options, so `[options]` says nothing). */
function subcommandTerm(cmd: CommandUnknownOpts): string {
	const args = cmd.registeredArguments.map((a) => {
		const name = `${a.name()}${a.variadic ? "..." : ""}`;
		return a.required ? `<${name}>` : `[${name}]`;
	});
	return [[cmd.name(), ...cmd.aliases()].join("|"), ...args].join(" ");
}

/**
 * Help in the batch grid's palette: bold titles + `warden <cmd>`, cyan command and option names, dim
 * argument placeholders; wrapped to the terminal. Subcommands inherit it.
 */
function helpStyle(ui: Ui): HelpConfiguration {
	const { color } = ui;
	return {
		helpWidth: ui.columns,
		subcommandTerm,
		styleTitle: (text) => color.bold(text),
		styleCommandText: (text) => color.bold(text),
		styleSubcommandText: (text) => color.cyan(text),
		styleOptionText: (text) => color.cyan(text),
		styleArgumentText: (text) => color.dim(text),
	};
}

/** commander's `error: unknown option '--x'` → `✗ warden claim: unknown option '--x'` at a terminal. */
function usageError(ui: Ui, argv: readonly string[], names: ReadonlySet<string>, text: string): string {
	if (!ui.rich) return ui.color.red(text);
	const scope = argv[0] !== undefined && names.has(argv[0]) ? `warden ${argv[0]}` : "warden";
	return ui.color.red(text.replace(/^error: /, `${SYMBOLS.fail} ${scope}: `));
}

/**
 * Build a fresh commander program (option values persist on a program between parses) with
 * `commands`, parse `argv`, run the matching action. Help → 0; usage errors → 1 (commander has
 * already printed them, in red, to ctx.err); otherwise the action's exit code.
 * `known` is every command name the CLI has (defaults to `commands`): a lazily loaded program registers
 * only the dispatched command but still scopes its usage errors as `warden <command>`.
 */
export async function runProgram(
	commands: readonly Command[],
	argv: string[],
	ctx: CommandContext,
	known: readonly Pick<Command, "name" | "aliases">[] = commands
): Promise<number> {
	const names = new Set(known.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
	const program = new Commander("warden")
		.description(PROGRAM_DESCRIPTION)
		.exitOverride()
		.enablePositionalOptions()
		.configureOutput({
			writeOut: (text) => ctx.out(chomp(text)),
			writeErr: (text) => ctx.err(chomp(text)),
			outputError: (text, write) => write(usageError(ctx.ui, argv, names, text)),
			getOutHasColors: () => ctx.ui.color.level > 0,
			getErrHasColors: () => ctx.ui.color.level > 0,
			getOutHelpWidth: () => ctx.ui.columns,
			getErrHelpWidth: () => ctx.ui.columns,
		})
		.configureHelp(helpStyle(ctx.ui))
		.showHelpAfterError(ctx.ui.color.dim("(add --help for usage)"));
	let code = 0;
	const grouped = [...commands].sort(
		(a, b) => COMMAND_GROUPS.indexOf(a.group ?? "Setup") - COMMAND_GROUPS.indexOf(b.group ?? "Setup")
	);
	for (const command of grouped) {
		const sub = program
			.command(command.name, command.hidden ? { hidden: true } : undefined)
			.description(command.summary);
		if (command.group) sub.helpGroup(`${command.group}:`);
		for (const alias of command.aliases ?? []) sub.alias(alias);
		command.register(sub, ctx, (n) => {
			code = n;
		});
	}
	program.commandsGroup("Setup:").helpCommand(true);
	try {
		await program.parseAsync(argv, { from: "user" });
	} catch (error) {
		if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 1;
		throw error;
	}
	return code;
}

/**
 * `runProgram` over a lazy listing: `warden <command> …` imports that command's module and no other; root
 * `--help`, no arguments, `help <command>` and anything unrecognised load them all, because commander
 * prints argument placeholders, suggests "did you mean" names and rejects unknown commands from the
 * registered set.
 */
export async function runLazyProgram(
	entries: readonly CommandEntry[],
	argv: string[],
	ctx: CommandContext
): Promise<number> {
	const first = argv[0];
	const target = first === undefined ? undefined : entries.find((e) => e.name === first || e.aliases?.includes(first));
	const commands = await Promise.all((target ? [target] : entries).map((entry) => entry.load()));
	return runProgram(commands, argv, ctx, entries);
}
