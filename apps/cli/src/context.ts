import type { AppHost } from "@delacour/warden-builds/prepare";
import type { HostFacts } from "@delacour/warden-leasing/host";
import { bunExec, type Exec } from "@delacour/warden-runtime/exec";
import { createGitFactsCache, type GitFactsCache } from "@delacour/warden-runtime/git-facts";
import { liveness } from "@delacour/warden-store/liveness";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import type { WardenHost } from "@delacour/warden-types/host";
import { renderLogEvent } from "./log-events";
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
	/** where `reportError` records a failure, for the `--json` error envelope `runProgram` prints */
	failure?: FailureSink;
};

/** Collects the failures a command reports; `runProgram` keeps the first. */
export type FailureSink = { record: (message: string, extra?: FailureExtra) => void };

/** What a failure adds to the `--json` envelope beyond its message: a machine code, a fix and structured details. */
export type FailureExtra =
	| { code: "ambiguous_device"; hint: string; details: Record<string, unknown> }
	| { code: "device_locked"; hint: string };

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

/**
 * The context as a {@link WardenHost}: the engine's injected effects. Its `log` renders each event on
 * `ctx.err` exactly as the engine used to print it, so build it from the context in force where `err`
 * is swapped (a spinner's).
 */
export function hostFromContext(ctx: CommandContext): WardenHost {
	return {
		env: ctx.env,
		cwd: ctx.cwd,
		home: storeLocator.wardenHome(ctx.env),
		now: ctx.now,
		exec: ctx.exec,
		sleep: (ms) => Bun.sleep(ms),
		pidAlive: liveness.processAlive,
		log: (event) => renderLogEvent(ctx, event),
	};
}

/** {@link hostFromContext} plus the shared store and git-facts memo: what app preparation reads. */
export function appHostFromContext(ctx: CommandContext): AppHost {
	return { ...hostFromContext(ctx), store: ctx.store, git: ctx.git };
}

export function defaultContext(argv: string[]): CommandContext {
	const env = process.env;
	let store: Store | undefined;
	return {
		argv,
		env,
		cwd: process.cwd(),
		now: () => Date.now(),
		out: STDOUT.write,
		err: STDERR.write,
		store: () => {
			store ??= storeLocator.open(storeLocator.defaultDbPath(env));
			return store;
		},
		exec: bunExec,
		git: createGitFactsCache(),
		readStdin: () => Bun.stdin.text(),
		ui: terminalUi(process.env),
	};
}
