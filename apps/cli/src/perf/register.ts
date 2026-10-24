import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import { registerCrashes } from "./crashes";
import { registerDiff } from "./diff";
import { registerDoctor } from "./doctor";
import { registerFrames } from "./frames";
import { registerHeap } from "./heap";
import { registerJs } from "./js";
import { registerLogs } from "./logs";
import { registerLs } from "./ls";
import { registerMark } from "./mark";
import { registerMemory } from "./memory";
import { registerMetrics } from "./metrics";
import { registerNative } from "./native";
import { registerQuery } from "./query";
import { registerReact } from "./react";
import { registerRecord } from "./record";
import { registerReport } from "./report";
import type { PerfDeps } from "./run";
import { registerStart } from "./start";
import { registerStartup } from "./startup";
import { registerStop } from "./stop";
import { registerTools } from "./tools";

/**
 * Wire one `warden perf` subcommand onto its commander node. The extension point: a phase adds a subcommand by
 * writing `perf/<sub>.ts` (a `register<Sub>` of this type whose `.action()` calls a plain
 * `(ctx, deps, …opts) → Promise<number>` and reports it with `done`) and adding that function to `PERF_SUBCOMMANDS`.
 */
export type PerfRegister = (cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps) => void;

/** Every `warden perf` subcommand, in `--help` order. One line per subcommand. */
export const PERF_SUBCOMMANDS: readonly PerfRegister[] = [
	registerStart,
	registerStop,
	registerRecord,
	registerMark,
	registerReport,
	registerQuery,
	registerDiff,
	registerMetrics,
	registerMemory,
	registerFrames,
	registerStartup,
	registerJs,
	registerHeap,
	registerReact,
	registerNative,
	registerLogs,
	registerCrashes,
	registerLs,
	registerDoctor,
	registerTools,
];
