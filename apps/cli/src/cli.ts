#!/usr/bin/env bun
import { type CommandEntry, programRunner } from "./command";
import { COMMANDS } from "./commands/registry";
import { type CommandContext, contextBuilder, STDERR, STDOUT } from "./context";

export class CliEntry {
	/**
	 * Run warden with `argv` (without `bun cli.ts`). Returns the exit code. Only the dispatched command's module is
	 * imported (`runLazyProgram`); `entries` is injectable so tests can watch what gets loaded.
	 */
	async main(
		argv: string[],
		makeContext: (argv: string[]) => CommandContext = contextBuilder.defaultContext.bind(contextBuilder),
		entries: readonly CommandEntry[] = COMMANDS
	): Promise<number> {
		const [first, ...rest] = argv;
		const normalised = first === "--version" || first === "-V" ? ["version", ...rest] : argv;
		return programRunner.runLazy(entries, normalised, makeContext(normalised));
	}
}

export const cliEntry = new CliEntry();

/**
 * `.then`, not top-level `await`: `bun build --bytecode` emits CommonJS, which has no top-level await. Exit only
 * once stdout and stderr have flushed: `process.exit` drops queued writes.
 */
if (import.meta.main) {
	cliEntry.main(process.argv.slice(2)).then(async (code) => {
		await Promise.all([STDOUT.drained(), STDERR.drained()]);
		process.exit(code);
	});
}
