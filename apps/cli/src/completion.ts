import type { CommandUnknownOpts, Option } from "@commander-js/extra-typings";

export type CandidateKind = "command" | "option" | "value";
export type Candidate = { kind: CandidateKind; value: string; description: string };
/** `files` = the word is free-form (a path, an id): the shell adds its own file completion. */
export type Completion = { candidates: Candidate[]; files: boolean };

/** Visible subcommands (no hidden workers, no commander's `help [command]`). */
function subcommands(cmd: CommandUnknownOpts): CommandUnknownOpts[] {
	return cmd
		.createHelp()
		.visibleCommands(cmd)
		.filter((sub) => sub.name() !== "help");
}

/** Visible options, `--help` included. */
function visibleOptions(cmd: CommandUnknownOpts): Option[] {
	return cmd.createHelp().visibleOptions(cmd);
}

function findSubcommand(cmd: CommandUnknownOpts, word: string): CommandUnknownOpts | undefined {
	return cmd.commands.find((sub) => sub.name() === word || sub.aliases().includes(word));
}

/** Every option (hidden ones too) by `--long` / `-s`, `--long=value` matched on its name. */
function findOption(cmd: CommandUnknownOpts, word: string): Option | undefined {
	const name = word.split("=")[0];
	return [...cmd.options, ...visibleOptions(cmd)].find((opt) => opt.long === name || opt.short === name);
}

/** `--udid <udid>` eats the next word; `[value]` options and flags don't. */
const takesValue = (opt: Option): boolean => opt.required;

/**
 * `.choices()`, else the `ios | android` that leads a help text (`[platform]`, `--platform <p>`): lets
 * completion offer values without commander rejecting them before the action's own validation.
 */
function valueChoices(item: { argChoices?: string[]; description: string }): readonly string[] | undefined {
	if (item.argChoices) return item.argChoices;
	const hint = /^([a-z0-9][\w.-]*(?: \| [a-z0-9][\w.-]*)+)(?:\s|$)/i.exec(item.description)?.[1];
	return hint?.split(" | ");
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

function choices(values: readonly string[], prefix: string, current: string): Candidate[] {
	return values
		.map((v) => `${prefix}${v}`)
		.filter((v) => v.startsWith(current))
		.map((value) => ({ kind: "value", value, description: "" }));
}

function optionCandidates(cmd: CommandUnknownOpts, current: string, used: ReadonlySet<Option>): Candidate[] {
	return visibleOptions(cmd)
		.filter((opt) => opt.variadic || !used.has(opt))
		.flatMap((opt) => {
			const value = opt.long ?? opt.short;
			return value?.startsWith(current)
				? [{ kind: "option" as const, value, description: oneLine(opt.description) }]
				: [];
		});
}

/**
 * What can follow `warden <words…>`: `words` are the arguments after `warden`, the last one being the word
 * under the cursor ("" for a fresh word). Walks the same commander tree `--help` prints, so subcommands,
 * options and `.choices()` never drift from the CLI.
 */
export function complete(root: CommandUnknownOpts, words: readonly string[]): Completion {
	const current = words.at(-1) ?? "";
	let cmd = root;
	let pending: Option | undefined;
	let positional = 0;
	let used = new Set<Option>();
	for (const word of words.slice(0, -1)) {
		if (pending) {
			pending = undefined;
			continue;
		}
		if (word.startsWith("-") && word !== "-" && word !== "--") {
			const opt = findOption(cmd, word);
			if (!opt) continue;
			used.add(opt);
			if (takesValue(opt) && !word.includes("=")) pending = opt;
			continue;
		}
		const sub = findSubcommand(cmd, word);
		if (sub) {
			cmd = sub;
			positional = 0;
			used = new Set();
			continue;
		}
		if (subcommands(cmd).length > 0 && cmd.registeredArguments.length === 0) return { candidates: [], files: false };
		positional++;
	}

	if (pending) {
		const values = valueChoices(pending);
		return values ? { candidates: choices(values, "", current), files: false } : { candidates: [], files: true };
	}
	if (current.startsWith("-")) {
		const eq = current.indexOf("=");
		if (eq > 0) {
			const opt = findOption(cmd, current);
			return { candidates: choices((opt && valueChoices(opt)) ?? [], current.slice(0, eq + 1), current), files: false };
		}
		return { candidates: optionCandidates(cmd, current, used), files: false };
	}

	const subs = subcommands(cmd)
		.filter((sub) => sub.name().startsWith(current))
		.map((sub): Candidate => ({ kind: "command", value: sub.name(), description: oneLine(sub.description()) }));
	if (subs.length > 0) return { candidates: subs, files: false };
	if (subcommands(cmd).length > 0) return { candidates: [], files: false };

	const args = cmd.registeredArguments;
	const arg = args[positional] ?? (args.at(-1)?.variadic ? args.at(-1) : undefined);
	const values = arg && valueChoices(arg);
	if (values) return { candidates: choices(values, "", current), files: false };
	if (arg) return { candidates: [], files: true };
	return { candidates: current === "" ? optionCandidates(cmd, current, used) : [], files: false };
}

/** `warden __complete` output: one `kind<TAB>value<TAB>description` line per candidate, then `files` if wanted. */
export function formatCompletion(result: Completion): string[] {
	const lines = result.candidates.map((c) => `${c.kind}\t${c.value}\t${oneLine(c.description)}`);
	return result.files ? [...lines, "files"] : lines;
}
