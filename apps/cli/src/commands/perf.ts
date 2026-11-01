import { CliCommand, type CommandNode } from "../command";
import type { CommandContext } from "../context";
import { PERF_SUBCOMMANDS, type PerfRegister } from "../perf/register";
import { defaultPerfDeps, type PerfDeps } from "../perf/run";

export class PerfCommand extends CliCommand {
	override readonly name = "perf";
	override readonly group = "Run";
	override readonly summary =
		"profile an app on a warden device: sessions, marks, doctor (CPU, memory, frames, startup, JS, React, native)";

	constructor(
		private readonly deps: PerfDeps = defaultPerfDeps,
		private readonly subcommands: readonly PerfRegister[] = PERF_SUBCOMMANDS
	) {
		super();
	}

	protected register(cmd: CommandNode, ctx: CommandContext, done: (code: number) => void): void {
		for (const register of this.subcommands) register(cmd, ctx, done, this.deps);
	}
}

export const perfCommand = new PerfCommand().definition();
