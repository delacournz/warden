import type { Command as Commander } from "@commander-js/extra-typings";
import {
	type CrashDeps,
	type CrashesParams,
	defaultCrashDeps,
	perfCrashesOps,
} from "@delacour/warden-sdk/ops/perf/crashes";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";
export type PerfCrashesOptions = PerfOptionValues & CrashesParams;

/**
 * `warden perf crashes`: crashes and ANRs of the app (see `readCrashes`). Raw reports are copied into the device's
 * active session (`crashes/`). `--symbolicate --dsym <path>` resolves iOS app frames. An `observe` op: needs no lease.
 */
export async function perfCrashes(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: PerfCrashesOptions,
	crashDeps: CrashDeps = defaultCrashDeps
): Promise<number> {
	return runPerf(ctx, deps, "crashes", "observe", opts, (target, env) =>
		perfCrashesOps.crashesWork(
			ctx,
			deps,
			target,
			opts,
			env.timeoutMs,
			(flag) => resolveApp(ctx, { platform: target.platform, id: target.udid }, flag),
			crashDeps
		)
	);
}

/** Wire `crashes` onto `warden perf`. */
export function registerCrashes(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: PerfDeps
): void {
	withPerfOptions(
		cmd
			.command("crashes")
			.description("crashes and ANRs of the app (iOS .ips reports, Android crash log + dropbox)")
			.option("--since <duration>", "only crashes from the last 30s | 5m | 1h")
			.option("--symbolicate", "resolve iOS app frames through a dSYM (needs --dsym)")
			.option("--dsym <path>", "the .dSYM (or DWARF file) of the build that crashed")
	).action(async (opts) => {
		done(await perfCrashes(ctx, deps, opts));
	});
}
