#!/usr/bin/env bun
import { runProgram } from "./command";
import { COMMANDS } from "./commands/registry";
import { type CommandContext, defaultContext } from "./context";

/** Run warden with `argv` (without `bun cli.ts`). Returns the exit code. */
export async function main(
	argv: string[],
	makeContext: (argv: string[]) => CommandContext = defaultContext
): Promise<number> {
	const [first, ...rest] = argv;
	const normalised = first === "--version" || first === "-V" ? ["version", ...rest] : argv;
	return runProgram(COMMANDS, normalised, makeContext(normalised));
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
