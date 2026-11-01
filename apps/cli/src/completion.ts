import type { CommandUnknownOpts, Option } from "@commander-js/extra-typings";

export type CandidateKind = "command" | "option" | "value";
export type Candidate = { kind: CandidateKind; value: string; description: string };
/** `files` = the word is free-form (a path, an id): the shell adds its own file completion. */
export type Completion = { candidates: Candidate[]; files: boolean };

const NOTHING: Completion = { candidates: [], files: false };

/** Where the finished words leave the cursor: the command reached, an option awaiting its value, the positional index. */
type Walk = {
	cmd: CommandUnknownOpts;
	pending: Option | undefined;
	positional: number;
	used: Set<Option>;
	/** a leaf-less command given a stray word: nothing can follow */
	dead: boolean;
};

export class CompletionHelpers {
	/** Visible subcommands (no hidden workers, no commander's `help [command]`). */
	private subcommands(cmd: CommandUnknownOpts): CommandUnknownOpts[] {
		return cmd
			.createHelp()
			.visibleCommands(cmd)
			.filter((sub) => sub.name() !== "help");
	}

	/** Visible options, `--help` included. */
	private visibleOptions(cmd: CommandUnknownOpts): Option[] {
		return cmd.createHelp().visibleOptions(cmd);
	}

	private findSubcommand(cmd: CommandUnknownOpts, word: string): CommandUnknownOpts | undefined {
		return cmd.commands.find((sub) => sub.name() === word || sub.aliases().includes(word));
	}

	/** Every option (hidden ones too) by `--long` / `-s`, `--long=value` matched on its name. */
	private findOption(cmd: CommandUnknownOpts, word: string): Option | undefined {
		const name = word.split("=")[0];
		return [...cmd.options, ...this.visibleOptions(cmd)].find((opt) => opt.long === name || opt.short === name);
	}

	/** `--udid <udid>` eats the next word; `[value]` options and flags don't. */
	private takesValue(opt: Option): boolean {
		return opt.required;
	}

	/**
	 * `.choices()`, else the `ios | android` that leads a help text (`[platform]`, `--platform <p>`): lets
	 * completion offer values without commander rejecting them before the action's own validation.
	 */
	private valueChoices(item: { argChoices?: string[]; description: string }): readonly string[] | undefined {
		if (item.argChoices) return item.argChoices;
		const hint = /^([a-z0-9][\w.-]*(?: \| [a-z0-9][\w.-]*)+)(?:\s|$)/i.exec(item.description)?.[1];
		return hint?.split(" | ");
	}

	private oneLine(text: string): string {
		return text.replace(/\s+/g, " ").trim();
	}

	private choices(values: readonly string[], prefix: string, current: string): Candidate[] {
		return values
			.map((v) => `${prefix}${v}`)
			.filter((v) => v.startsWith(current))
			.map((value) => ({ kind: "value", value, description: "" }));
	}

	private optionCandidates(cmd: CommandUnknownOpts, current: string, used: ReadonlySet<Option>): Candidate[] {
		return this.visibleOptions(cmd)
			.filter((opt) => opt.variadic || !used.has(opt))
			.flatMap((opt) => {
				const value = opt.long ?? opt.short;
				return value?.startsWith(current)
					? [{ kind: "option" as const, value, description: this.oneLine(opt.description) }]
					: [];
			});
	}

	/** Step the walk over one finished word: a pending option's value, an option, a subcommand or a positional. */
	private stepWalk(walk: Walk, word: string): void {
		if (walk.pending) {
			walk.pending = undefined;
			return;
		}
		if (word.startsWith("-") && word !== "-" && word !== "--") {
			const opt = this.findOption(walk.cmd, word);
			if (!opt) return;
			walk.used.add(opt);
			if (this.takesValue(opt) && !word.includes("=")) walk.pending = opt;
			return;
		}
		const sub = this.findSubcommand(walk.cmd, word);
		if (sub) {
			walk.cmd = sub;
			walk.positional = 0;
			walk.used = new Set();
			return;
		}
		if (this.subcommands(walk.cmd).length > 0 && walk.cmd.registeredArguments.length === 0) {
			walk.dead = true;
			return;
		}
		walk.positional++;
	}

	/** Candidates for a word starting with `-`: `--opt=` values, else the options. */
	private completeDashed(cmd: CommandUnknownOpts, current: string, used: ReadonlySet<Option>): Completion {
		const eq = current.indexOf("=");
		if (eq <= 0) return { candidates: this.optionCandidates(cmd, current, used), files: false };
		const opt = this.findOption(cmd, current);
		return {
			candidates: this.choices((opt && this.valueChoices(opt)) ?? [], current.slice(0, eq + 1), current),
			files: false,
		};
	}

	/** Candidates for the next positional argument (or options on a fresh word) once no subcommand matches. */
	private completePositional(walk: Walk, current: string): Completion {
		const { cmd } = walk;
		const args = cmd.registeredArguments;
		const arg = args[walk.positional] ?? (args.at(-1)?.variadic ? args.at(-1) : undefined);
		const values = arg && this.valueChoices(arg);
		if (values) return { candidates: this.choices(values, "", current), files: false };
		if (arg) return { candidates: [], files: true };
		return { candidates: current === "" ? this.optionCandidates(cmd, current, walk.used) : [], files: false };
	}

	/**
	 * What can follow `warden <words…>`: `words` are the arguments after `warden`, the last one being the word
	 * under the cursor ("" for a fresh word). Walks the same commander tree `--help` prints, so subcommands,
	 * options and `.choices()` never drift from the CLI.
	 */
	complete(root: CommandUnknownOpts, words: readonly string[]): Completion {
		const current = words.at(-1) ?? "";
		const walk: Walk = { cmd: root, pending: undefined, positional: 0, used: new Set(), dead: false };
		for (const word of words.slice(0, -1)) {
			this.stepWalk(walk, word);
			if (walk.dead) return NOTHING;
		}

		if (walk.pending) {
			const values = this.valueChoices(walk.pending);
			return values ? { candidates: this.choices(values, "", current), files: false } : { candidates: [], files: true };
		}
		if (current.startsWith("-")) return this.completeDashed(walk.cmd, current, walk.used);

		const subs = this.subcommands(walk.cmd)
			.filter((sub) => sub.name().startsWith(current))
			.map((sub): Candidate => ({ kind: "command", value: sub.name(), description: this.oneLine(sub.description()) }));
		if (subs.length > 0) return { candidates: subs, files: false };
		if (this.subcommands(walk.cmd).length > 0) return NOTHING;
		return this.completePositional(walk, current);
	}

	/** `warden __complete` output: one `kind<TAB>value<TAB>description` line per candidate, then `files` if wanted. */
	formatCompletion(result: Completion): string[] {
		const lines = result.candidates.map((c) => `${c.kind}\t${c.value}\t${this.oneLine(c.description)}`);
		return result.files ? [...lines, "files"] : lines;
	}
}

export const completionHelpers = new CompletionHelpers();
