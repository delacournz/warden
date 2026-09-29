import { bunExec, type Exec } from "@warden/core/exec";
import { openStore, type Store } from "@warden/core/store";
import { terminalUi, type Ui } from "./ui";

/** Everything a command touches from the outside world — injectable for tests. */
export type CommandContext = {
	/** args after the subcommand name */
	argv: string[];
	env: Record<string, string | undefined>;
	cwd: string;
	now: () => number;
	out: (line: string) => void;
	err: (line: string) => void;
	/** lazily opened, shared store */
	store: () => Store;
	exec: Exec;
	readStdin: () => Promise<string>;
	/** colours, spinners, prompts */
	ui: Ui;
};

export function defaultContext(argv: string[]): CommandContext {
	let store: Store | undefined;
	return {
		argv,
		env: process.env,
		cwd: process.cwd(),
		now: () => Date.now(),
		out: (line) => process.stdout.write(`${line}\n`),
		err: (line) => process.stderr.write(`${line}\n`),
		store: () => {
			store ??= openStore();
			return store;
		},
		exec: bunExec,
		readStdin: () => Bun.stdin.text(),
		ui: terminalUi(process.env),
	};
}
