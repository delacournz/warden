import { join } from "node:path";
import { ENV_NAMES } from "@delacour/warden-e2e/env";
import { resultsFiles, type TestResult } from "@delacour/warden-e2e/runner/results";
import type { VerifyInput, VerifyReport, VerifyTest } from "@delacour/warden-sdk/ops/authoring/deps";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import type { BatchDeps } from "../commands/batch";
import { e2e, type SpecPlanDeps } from "../commands/e2e";
import type { CommandContext } from "../context";
import { bunRunner } from "../e2e/bun-runner";
import { e2eLaunch } from "../e2e/launch";

export type { VerifyInput, VerifyReport, VerifyTest };

export type VerifyDeps = SpecPlanDeps & Pick<BatchDeps, "spawn" | "after" | "mkdir" | "readFile">;

export class UiAuthoringVerify {
	/** The tests of a spec process as `record stop` reports them. */
	private testsOf(results: readonly TestResult[]): VerifyTest[] {
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
	async runVerify(ctx: CommandContext, deps: VerifyDeps, input: VerifyInput): AsyncResult<VerifyReport> {
		const plan = await e2e.specPlan(ctx, deps, input.suite, input.platform);
		if (!plan.success) return plan;
		await deps.mkdir(input.outDir);
		const log = join(input.outDir, "spec.log");
		const resultsFile = join(input.outDir, "results.jsonl");
		const argv = bunRunner.runnerArgv({
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
			...bunRunner.specEnv({
				...plan.data.env,
				launchArgs: e2eLaunch.specLaunchArgs(plan.data.launch, input.metroUrl),
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
			return resultFactory.err(`could not start ${argv[0]}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const cancel = deps.after(input.suite.config.jobTimeoutMs, () => proc.kill("SIGTERM"));
		let exitCode: number;
		try {
			exitCode = await proc.exited;
		} finally {
			cancel();
		}
		const read = await deps.readFile(resultsFile).then(
			(text) => resultsFiles.read(text),
			() => []
		);
		const tests = this.testsOf(read);
		const passed = exitCode === 0 && tests.length > 0 && tests.every((test) => test.status === "passed");
		return resultFactory.ok({ passed, exitCode, outDir: input.outDir, log, results: resultsFile, tests });
	}
}

export const uiAuthoringVerify = new UiAuthoringVerify();
