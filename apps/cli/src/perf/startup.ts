import type { Command as Commander } from "@commander-js/extra-typings";
import type { StartupMethod } from "@delacour/warden-perf/startup/findings";
import {
	DEFAULT_RUNS,
	defaultStartupIo,
	MAX_RUNS,
	type StartupIo,
	type StartupKind,
	type StartupPlan,
	startupWork,
} from "@delacour/warden-sdk/ops/perf/startup";
import type { Platform } from "@delacour/warden-store/types";
import { ok, type Result } from "@delacour/warden-types/result";
import { type UiError, uiError } from "../agent-ui/output";
import type { CommandContext } from "../context";
import { resolveApp } from "./app";
import { withPerfOptions } from "./options";
import { type PerfDeps, type PerfOptionValues, runPerf } from "./run";

export type { StartupIo, StartupKind };

export type StartupOptions = PerfOptionValues & { cold?: true; warm?: true; runs?: string; method?: string };

const fail = (error: UiError): { success: false; error: UiError } => ({ success: false, error });

function parseRuns(raw: string | undefined): Result<number, UiError> {
	if (raw === undefined) return ok(DEFAULT_RUNS);
	if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_RUNS) {
		return fail(uiError("usage", `--runs must be an integer 1-${MAX_RUNS}, got "${raw}"`));
	}
	return ok(Number(raw));
}

type IosMethod = "approx" | "xctrace";

function parseMethod(raw: string | undefined, platform: Platform): Result<StartupMethod, UiError> {
	if (platform === "android") {
		return raw === undefined || raw === "am-start"
			? ok("am-start")
			: fail(uiError("usage", `--method ${raw} is iOS only (Android always uses am start -W)`));
	}
	const method: IosMethod | undefined =
		raw === undefined || raw === "approx" ? "approx" : raw === "xctrace" ? "xctrace" : undefined;
	if (method === undefined) return fail(uiError("usage", `--method must be approx or xctrace, got "${raw}"`));
	return ok(method === "approx" ? "simctl-approx" : "xctrace");
}

/** `--runs`, `--method` (per platform) and `--cold|--warm` (default cold) as a plan, or a usage error. */
function planOf(opts: StartupOptions, platform: Platform): Result<StartupPlan, UiError> {
	const count = parseRuns(opts.runs);
	if (!count.success) return count;
	const method = parseMethod(opts.method, platform);
	if (!method.success) return method;
	const kinds: StartupKind[] = [];
	if (opts.cold === true || opts.warm !== true) kinds.push("cold");
	if (opts.warm === true) kinds.push("warm");
	return ok({ count: count.data, method: method.data, kinds });
}

/** `warden perf startup`: cold/warm app start time, median and p90 over `--runs`. Mutates the app, so it needs the caller's lease (`--claim`). */
export function perfStartup(
	ctx: CommandContext,
	deps: PerfDeps,
	opts: StartupOptions,
	io: StartupIo = defaultStartupIo
): Promise<number> {
	return runPerf(ctx, deps, "startup", "mutate", opts, async (target) => {
		const plan = planOf(opts, target.platform);
		if (!plan.success) return plan;
		const app = await resolveApp(ctx, { platform: target.platform, id: target.udid }, opts.app);
		if (!app.success) return app;
		return startupWork(ctx, deps, target, app.data.id, plan.data, io);
	});
}

/** Wire `startup` onto `warden perf`. */
export function registerStartup(
	cmd: Commander,
	ctx: CommandContext,
	done: (code: number) => void,
	deps: PerfDeps
): void {
	withPerfOptions(
		cmd
			.command("startup")
			.description(
				"cold/warm app start time: median and p90 over --runs (kills and relaunches the app: needs your lease or --claim)"
			)
			.option("--cold", "force-stop the app before each start (default)")
			.option("--warm", "send the app to the background (HOME) before each start")
			.option("--runs <n>", `launches to time, 1-${MAX_RUNS} (default ${DEFAULT_RUNS})`)
			.option(
				"--method <m>",
				"iOS: approx (simctl launch wall time, default) | xctrace (App Launch template, cold only)"
			)
	).action(async (opts) => {
		done(await perfStartup(ctx, deps, opts));
	});
}
