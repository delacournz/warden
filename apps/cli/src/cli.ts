#!/usr/bin/env bun
import { COMMANDS } from "./commands/registry";
import { type Command, type CommandContext, defaultContext } from "./context";

export function helpText(commands: readonly Command[]): string {
	const width = Math.max(...commands.map((c) => c.name.length));
	return [
		"warden — machine-wide device + port leasing for agents and users",
		"",
		"usage: warden <command> [options]   (all commands accept --json)",
		"",
		...commands.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
		"",
		"warden <command> --help for details",
	].join("\n");
}

/** Dispatch `argv` (without `bun cli.ts`) to a command. Returns the exit code. */
export async function main(
	argv: string[],
	makeContext: (rest: string[]) => CommandContext = defaultContext
): Promise<number> {
	const [name, ...rest] = argv;
	if (name === undefined || name === "help" || name === "--help" || name === "-h") {
		process.stdout.write(`${helpText(COMMANDS)}\n`);
		return name === undefined ? 1 : 0;
	}
	const command = COMMANDS.find((c) => c.name === name);
	const ctx = makeContext(rest);
	if (!command) {
		ctx.err(`warden: unknown command "${name}"\n\n${helpText(COMMANDS)}`);
		return 1;
	}
	if (rest.includes("--help") || rest.includes("-h")) {
		ctx.out(`${command.usage}\n\n${command.summary}`);
		return 0;
	}
	return command.run(ctx);
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
