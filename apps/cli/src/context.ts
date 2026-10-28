import { bunExec, type Exec } from "@delacour/warden-core/exec";
import { createGitFactsCache, type GitFactsCache } from "@delacour/warden-core/git-facts";
import type { HostFacts } from "@delacour/warden-core/host";
import { openStore, type Store } from "@delacour/warden-core/store";
import { terminalUi, type Ui } from "./ui";

/** Everything a command touches from the outside world — injectable for tests. */
export type CommandContext = {
	/** args after the subcommand name */
	argv: string[];
	env: Record<string, string | undefined>;
	cwd: string;
	/** the host platform; default `process.platform` (window commands are macOS-only; tests inject it) */
	os?: NodeJS.Platform;
	now: () => number;
	out: (line: string) => void;
	err: (line: string) => void;
	/** lazily opened, shared store */
	store: () => Store;
	exec: Exec;
	/** this command's memo of the git facts (toplevel, common dir, branch): every reader in one command shares it */
	git: GitFactsCache;
	readStdin: () => Promise<string>;
	/** colours, spinners, prompts */
	ui: Ui;
	/** RAM + cores the capacity budget is sized from; unset = read the host (`readHostFacts`) */
	hostFacts?: () => Promise<HostFacts>;
};

/** Line writes to a process stream that remember backpressure, so the process can wait for them before exiting. */
export type LineWriter = {
	write: (line: string) => void;
	/** resolves once every queued write has flushed, or the reader has gone (`| head`) */
	drained: () => Promise<void>;
};

/**
 * A pipe queues writes once its 64 KB buffer is full and `process.exit` drops that queue, which cut a large
 * `--json` document off for a reader that started late. Bun reports the full buffer only through `write`'s
 * return value (`writableNeedDrain` stays false), so that is what is tracked.
 */
export function lineWriter(stream: NodeJS.WritableStream): LineWriter {
	let backlog = false;
	return {
		write: (line) => {
			if (!stream.write(`${line}\n`)) backlog = true;
		},
		drained: () => {
			if (!backlog) return Promise.resolve();
			return new Promise((done) => {
				const events = ["drain", "error", "close"] as const;
				const finish = () => {
					for (const event of events) stream.off(event, finish);
					backlog = false;
					done();
				};
				for (const event of events) stream.once(event, finish);
			});
		},
	};
}

export const STDOUT = lineWriter(process.stdout);
export const STDERR = lineWriter(process.stderr);

export function defaultContext(argv: string[]): CommandContext {
	let store: Store | undefined;
	return {
		argv,
		env: process.env,
		cwd: process.cwd(),
		now: () => Date.now(),
		out: STDOUT.write,
		err: STDERR.write,
		store: () => {
			store ??= openStore();
			return store;
		},
		exec: bunExec,
		git: createGitFactsCache(),
		readStdin: () => Bun.stdin.text(),
		ui: terminalUi(process.env),
	};
}
