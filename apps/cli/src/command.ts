import {
	Command as Commander,
	CommanderError,
	type CommandUnknownOpts,
	type HelpConfiguration,
} from "@commander-js/extra-typings";
import type { CommandContext, FailureExtra } from "./context";
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
 * What a failed `--json` run prints when the command left stdout empty, in the `warden ui` envelope's shape:
 * `usage` for commander's errors (unknown option, missing argument), `failed` for the rest.
 */
export type JsonFailure = {
	ok: false;
	command: string;
	error: { code: "usage" | "failed"; message: string } | ({ message: string } & FailureExtra);
};

/** `ui snapshot` from `["ui", "snapshot", "--json"]`: the command words of `argv`, as registered. */
function commandPath(program: CommandUnknownOpts, argv: readonly string[]): string {
	const path: string[] = [];
	let node = program;
	for (const word of argv) {
		const next = node.commands.find((c) => c.name() === word || c.aliases().includes(word));
		if (!next) break;
		path.push(next.name());
		node = next;
	}
	return path.join(" ");
}

/**
 * Build a fresh commander program (option values persist on a program between parses) with
 * `commands`, parse `argv`, run the matching action. Help → 0; usage errors → 1 (commander has
 * already printed them, in red, to ctx.err); otherwise the action's exit code.
 * `known` is every command name the CLI has (defaults to `commands`): a lazily loaded program registers
 * only the dispatched command but still scopes its usage errors as `warden <command>`.
 * A `--json` run that fails with nothing on stdout gets a `JsonFailure` there, carrying the first
 * `reportError` message, so every failure is one JSON document too (the red line stays on stderr).
 */
export async function runProgram(
	commands: readonly Command[],
	argv: string[],
	ctx: CommandContext,
	known: readonly Pick<Command, "name" | "aliases">[] = commands
): Promise<number> {
	let code = 0;
	let json = false;
	let wrote = false;
	let failure: JsonFailure["error"] | undefined;
	const tracked: CommandContext = {
		...ctx,
		out: (line) => {
			wrote = true;
			ctx.out(line);
		},
		failure: {
			record: (message, extra) => {
				failure ??= extra ? { message, ...extra } : { code: "failed", message };
				ctx.failure?.record(message, extra);
			},
		},
	};
	const program = buildProgram(commands, argv, tracked, known, (n) => {
		code = n;
	});
	program.hook("preAction", (_root, action) => {
		json = action.opts().json === true;
	});
	try {
		await program.parseAsync(argv, { from: "user" });
	} catch (error) {
		if (!(error instanceof CommanderError)) throw error;
		if (error.exitCode === 0) return 0;
		code = 1;
		// no action ran, so `--json` is read off argv: before `--`, past it the words are a child's
		const end = argv.indexOf("--");
		json = (end === -1 ? argv : argv.slice(0, end)).includes("--json");
		failure = { code: "usage", message: error.message.replace(/^error: /, "") };
	}
	if (code !== 0 && json && !wrote) {
		const command = commandPath(program, argv);
		const error = failure ?? { code: "failed", message: `warden ${command} exited ${code}` };
		const doc: JsonFailure = { ok: false, command, error };
		ctx.out(JSON.stringify(doc));
	}
	return code;
}

/**
 * The commander tree `runProgram` parses: every command registered under its group, help styled, output
 * routed through `ctx`. Also what `warden __complete` walks, so completions can't drift from `--help`.
 */
export function buildProgram(
	commands: readonly Command[],
	argv: readonly string[],
	ctx: CommandContext,
	known: readonly Pick<Command, "name" | "aliases">[] = commands,
	done: (code: number) => void = () => {}
): Commander {
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
	const grouped = [...commands].sort(
		(a, b) => COMMAND_GROUPS.indexOf(a.group ?? "Setup") - COMMAND_GROUPS.indexOf(b.group ?? "Setup")
	);
	for (const command of grouped) {
		const sub = program
			.command(command.name, command.hidden ? { hidden: true } : undefined)
			.description(command.summary);
		if (command.group) sub.helpGroup(`${command.group}:`);
		for (const alias of command.aliases ?? []) sub.alias(alias);
		command.register(sub, ctx, done);
	}
	program.commandsGroup("Setup:").helpCommand(true);
	return program;
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
