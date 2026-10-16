#!/usr/bin/env bun
import { type CommandEntry, runLazyProgram } from "./command";
import { COMMANDS } from "./commands/registry";
import { type CommandContext, defaultContext } from "./context";

/**
 * Run warden with `argv` (without `bun cli.ts`). Returns the exit code. Only the dispatched command's module is
 * imported (`runLazyProgram`); `entries` is injectable so tests can watch what gets loaded.
 */
export async function main(
	argv: string[],
	makeContext: (argv: string[]) => CommandContext = defaultContext,
	entries: readonly CommandEntry[] = COMMANDS
): Promise<number> {
	const [first, ...rest] = argv;
	const normalised = first === "--version" || first === "-V" ? ["version", ...rest] : argv;
	return runLazyProgram(entries, normalised, makeContext(normalised));
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
