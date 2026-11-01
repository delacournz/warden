import type { Command as Commander } from "@commander-js/extra-typings";
import type { CommandContext } from "../context";
import { perfCrashesCli } from "./crashes";
import { perfDiffCli } from "./diff";
import { perfDoctorCli } from "./doctor";
import { perfFramesCli } from "./frames";
import { perfHeapCli } from "./heap";
import { perfJsCli } from "./js";
import { perfLogsCli } from "./logs";
import { perfLsCli } from "./ls";
import { perfMarkCli } from "./mark";
import { perfMemoryCli } from "./memory";
import { perfMetricsCli } from "./metrics";
import { perfNativeCli } from "./native";
import { perfQueryCli } from "./query";
import { perfReactCli } from "./react";
import { perfRecordCli } from "./record";
import { perfReportCli } from "./report";
import type { PerfDeps } from "./run";
import { perfStartCli } from "./start";
import { perfStartupCli } from "./startup";
import { perfStopCli } from "./stop";
import { perfToolsCli } from "./tools";

/**
 * Wire one `warden perf` subcommand onto its commander node. The extension point: a phase adds a subcommand by
 * writing `perf/<sub>.ts` (a `register<Sub>` of this type whose `.action()` calls a plain
 * `(ctx, deps, …opts) → Promise<number>` and reports it with `done`) and adding that function to `PERF_SUBCOMMANDS`.
 */
export type PerfRegister = (cmd: Commander, ctx: CommandContext, done: (code: number) => void, deps: PerfDeps) => void;

/** Every `warden perf` subcommand, in `--help` order. One line per subcommand. */
export const PERF_SUBCOMMANDS: readonly PerfRegister[] = [
	perfStartCli.registerStart,
	perfStopCli.registerStop,
	perfRecordCli.registerRecord,
	perfMarkCli.registerMark,
	perfReportCli.registerReport,
	perfQueryCli.registerQuery,
	perfDiffCli.registerDiff,
	perfMetricsCli.registerMetrics,
	perfMemoryCli.registerMemory,
	perfFramesCli.registerFrames,
	perfStartupCli.registerStartup,
	perfJsCli.registerJs,
	perfHeapCli.registerHeap,
	perfReactCli.registerReact,
	perfNativeCli.registerNative,
	perfLogsCli.registerLogs,
	perfCrashesCli.registerCrashes,
	perfLsCli.registerLs,
	perfDoctorCli.registerDoctor,
	perfToolsCli.registerTools,
];
