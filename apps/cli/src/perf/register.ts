import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import { registerDoctor } from "./doctor";
import { registerLs } from "./ls";
import { registerMark } from "./mark";
import type { PerfDeps } from "./run";

/**
 * Wire one `warden perf` subcommand onto its commander node. The extension point: a phase adds a subcommand by
 * writing `perf/<sub>.ts` (a `register<Sub>` of this type whose `.action()` calls a plain
 * `(ctx, deps, …opts) → Promise<number>` and reports it with `done`) and adding that function to `PERF_SUBCOMMANDS`.
 */
export type PerfRegister = (cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps) => void;

/** Every `warden perf` subcommand, in `--help` order. One line per subcommand. */
export const PERF_SUBCOMMANDS: readonly PerfRegister[] = [registerLs, registerMark, registerDoctor];
