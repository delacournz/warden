import { type Command, defineCommand } from "../command";
import { PERF_SUBCOMMANDS, type PerfRegister } from "../perf/register";
import { defaultPerfDeps, type PerfDeps } from "../perf/run";

/**
 * `warden perf <subcommand>`: profile an app on a warden simulator / emulator. Subcommands live in
 * `perf/<sub>.ts` and are listed in `perf/register.ts` `PERF_SUBCOMMANDS`; `deps` injects the process table, the
 * booted-device list and host facts for tests. Exit codes are `warden ui`'s: 0 ok · 1 failed/usage · 2 lease.
 */
export function createPerfCommand(
	deps: PerfDeps = defaultPerfDeps,
	subcommands: readonly PerfRegister[] = PERF_SUBCOMMANDS
): Command {
	return defineCommand({
		name: "perf",
		group: "Run",
		summary:
			"profile an app on a warden device: sessions, marks, doctor (CPU, memory, frames, startup, JS, React, native)",
		register: (cmd, ctx, done) => {
			for (const register of subcommands) register(cmd, ctx, done, deps);
		},
	});
}

export const perfCommand = createPerfCommand();
