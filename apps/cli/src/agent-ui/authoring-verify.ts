import { join } from "node:path";
import type { Suite } from "@delacour/warden-core/affected/affected";
import type { Platform } from "@delacour/warden-core/types";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { readResults, type TestResult } from "@delacour/warden-e2e/runner/results";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { BatchDeps } from "../commands/batch";
import { type SpecPlanDeps, specPlan } from "../commands/e2e";
import type { CommandContext } from "../context";
import { runnerArgv, specEnv } from "../e2e/bun-runner";
import { specLaunchArgs } from "../e2e/launch";

/** Everything `record stop` needs to run the spec it just wrote once, on the device the recording was made on. */
export type VerifyInput = {
	udid: string;
	platform: Platform;
	deviceName?: string | undefined;
	/** absolute path of the generated spec */
	specPath: string;
	suite: Suite;
	/** where this run's `results.jsonl`, artifacts and `spec.log` go */
	outDir: string;
	/** the dev client's Metro (`ui open --metro`), when known */
	metroUrl?: string | undefined;
	/** the device's resident `warden-simd` socket, when one is running */
	simdSocket?: string | undefined;
};

export type VerifyTest = {
	title: string;
	status: TestResult["status"];
	durationMs: number;
	error?: string;
	/** the files the failed test left (`screen-at-failure.txt`, `failure.png`, …), absolute */
	evidence: string[];
};

export type VerifyReport = {
	passed: boolean;
	exitCode: number;
	outDir: string;
	log: string;
	results: string;
	tests: VerifyTest[];
};

export type VerifyDeps = SpecPlanDeps & Pick<BatchDeps, "spawn" | "after" | "mkdir" | "readFile">;

/** The tests of a spec process as `record stop` reports them. */
function testsOf(results: readonly TestResult[]): VerifyTest[] {
	return results.map((result) => ({
		title: result.title.join(" › "),
		status: result.status,
		durationMs: result.durationMs,
		...(result.error ? { error: result.error.message } : {}),
		evidence: (result.artifacts?.files ?? []).map((file) => join(result.artifacts?.dir ?? "", file)),
	}));
}

/**
 * Run the spec once as a `warden e2e` spec process would: the argv and env come from the same `specPlan`,
 * `runnerArgv` and `specEnv` the suite run uses (so the preload, bundle id, timeouts and `WARDEN_*` contract
 * are identical), plus the device's own identity. Resolves to a report either way; an `Err` means the run could
 * not start (no bun, no bundle id, …).
 */
export async function runVerify(ctx: CommandContext, deps: VerifyDeps, input: VerifyInput): AsyncResult<VerifyReport> {
	const plan = await specPlan(ctx, deps, input.suite, input.platform);
	if (!plan.success) return plan;
	await deps.mkdir(input.outDir);
	const log = join(input.outDir, "spec.log");
	const resultsFile = join(input.outDir, "results.jsonl");
	const argv = runnerArgv({
		bun: plan.data.bun,
		preload: plan.data.preload,
		specPaths: [input.specPath],
		timeoutMs: plan.data.env.timeouts.timeoutMs,
	});
	const lease = ctx
		.store()
		.listLeases()
		.find((l) => l.resource.kind === "device" && l.resource.id === input.udid);
	const env: Record<string, string | undefined> = {
		...ctx.env,
		...specEnv({
			...plan.data.env,
			launchArgs: specLaunchArgs(plan.data.launch, input.metroUrl),
			out: input.outDir,
		}),
		[ENV_NAMES.udid]: input.udid,
		...(lease !== undefined ? { [ENV_NAMES.leaseId]: lease.id } : {}),
		...(input.deviceName !== undefined ? { [ENV_NAMES.deviceName]: input.deviceName } : {}),
		...(input.metroUrl !== undefined ? { [ENV_NAMES.metroUrl]: input.metroUrl } : {}),
		...(input.simdSocket !== undefined ? { [ENV_NAMES.simdSocket]: input.simdSocket } : {}),
	};
	let proc: ReturnType<VerifyDeps["spawn"]>;
	try {
		proc = deps.spawn(argv, { env, log, cwd: input.suite.cwd, job: true, group: true });
	} catch (error) {
		return err(`could not start ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const cancel = deps.after(input.suite.config.jobTimeoutMs, () => proc.kill("SIGTERM"));
	let exitCode: number;
	try {
		exitCode = await proc.exited;
	} finally {
		cancel();
	}
	const read = await deps.readFile(resultsFile).then(
		(text) => readResults(text),
		() => []
	);
	const tests = testsOf(read);
	const passed = exitCode === 0 && tests.length > 0 && tests.every((test) => test.status === "passed");
	return ok({ passed, exitCode, outDir: input.outDir, log, results: resultsFile, tests });
}
