import { bunExec, type Exec } from "@warden/core/exec";
import { openStore, type Store } from "@warden/core/store";

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
};

export type Command = {
	name: string;
	aliases?: readonly string[];
	summary: string;
	usage: string;
	run: (ctx: CommandContext) => Promise<number>;
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
	};
}

/** Stub for commands not built yet. */
export function notImplemented(name: string): Command["run"] {
	return async (ctx) => {
		ctx.err(`warden ${name}: not implemented yet`);
		return 1;
	};
}
