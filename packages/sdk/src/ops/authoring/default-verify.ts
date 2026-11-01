import { join } from "node:path";
import { specIdOf } from "@delacour/warden-core/affected/specs";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { E2eReportJson } from "../../contracts/e2e-report.schema";
import type { Core } from "../../core";
import { bunSpecsDeps, e2eArgs, parseE2eReport, resolveCliCommand } from "../../specs";
import type { AuthoringDeps, VerifyInput, VerifyReport, VerifyTest } from "./deps";

type SpecVerdict = E2eReportJson["specs"][number];

/** A `warden e2e --json` spec verdict as the `record stop` report: its tests, with their artifact directories as evidence. */
function reportOf(
	verdict: SpecVerdict,
	input: VerifyInput,
	batchDir: string | undefined,
	exitCode: number
): VerifyReport {
	const outDir = batchDir ?? input.outDir;
	const tests: VerifyTest[] = (verdict.tests ?? []).map((test) => ({
		title: test.title.join(" › "),
		status: test.status,
		durationMs: test.durationMs,
		...(test.error !== undefined ? { error: test.error } : {}),
		evidence: test.artifacts !== undefined ? [test.artifacts] : [],
	}));
	return {
		passed: verdict.verdict === "passed",
		exitCode,
		outDir,
		log: verdict.log ?? join(outDir, "spec.log"),
		results: join(outDir, "results.jsonl"),
		tests,
	};
}

/**
 * The default `authoring.verify`: run just the written spec through `warden e2e <suite> --specs <id> --json` (the
 * WSDX-3 specs runner, spawned through `cliCommand` and the `specs` seam). `warden e2e` claims its own device of the
 * session's platform; the session's lease is left alone.
 */
export function specsVerify(core: Core): NonNullable<AuthoringDeps["verify"]> {
	return async (input: VerifyInput): AsyncResult<VerifyReport> => {
		const specsDir = join(input.suite.configDir, input.suite.config.specsDir);
		const id = specIdOf(input.specPath, specsDir);
		const argv = [
			...resolveCliCommand(core.options.cliCommand),
			...e2eArgs({
				...(input.suite.implicit === true ? {} : { suite: input.suite.name }),
				specs: [id],
				platform: input.platform,
			}),
		];
		const out = await (core.seams.specs ?? bunSpecsDeps).spawn(argv, {
			cwd: core.host.cwd,
			env: core.host.env,
			onStderrLine: () => undefined,
		});
		const report = parseE2eReport(out);
		if (!report.success)
			return err(`warden e2e exited ${out.exitCode} without a report: ${out.stderr.slice(-400).trim()}`);
		const verdict = report.data.specs.find((spec) => spec.id === id);
		if (!verdict) return err(`warden e2e did not run ${id}`);
		return ok(reportOf(verdict, input, report.data.batchDir, out.exitCode));
	};
}
