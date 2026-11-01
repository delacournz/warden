import { join } from "node:path";
import { specScanner } from "@delacour/warden-core/affected/specs";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import type { E2eReportJson } from "../../contracts/e2e-report.schema";
import type { Core } from "../../core";
import { specsCli } from "../../specs";
import type { AuthoringDeps, VerifyInput, VerifyReport, VerifyTest } from "./deps";

type SpecVerdict = E2eReportJson["specs"][number];

/** The default spec runner. */
export class SpecsVerifier {
	/** A `warden e2e --json` spec verdict as the `record stop` report: its tests, with their artifact directories as evidence. */
	private reportOf(
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
	specsVerify(core: Core): NonNullable<AuthoringDeps["verify"]> {
		return async (input: VerifyInput): AsyncResult<VerifyReport> => {
			const specsDir = join(input.suite.configDir, input.suite.config.specsDir);
			const id = specScanner.idOf(input.specPath, specsDir);
			const argv = [
				...specsCli.resolveCliCommand(core.options.cliCommand),
				...specsCli.e2eArgs({
					...(input.suite.implicit === true ? {} : { suite: input.suite.name }),
					specs: [id],
					platform: input.platform,
				}),
			];
			const out = await (core.seams.specs ?? specsCli.bunDeps).spawn(argv, {
				cwd: core.host.cwd,
				env: core.host.env,
				onStderrLine: () => undefined,
			});
			const report = specsCli.parseE2eReport(out);
			if (!report.success)
				return resultFactory.err(
					`warden e2e exited ${out.exitCode} without a report: ${out.stderr.slice(-400).trim()}`
				);
			const verdict = report.data.specs.find((spec) => spec.id === id);
			if (!verdict) return resultFactory.err(`warden e2e did not run ${id}`);
			return resultFactory.ok(this.reportOf(verdict, input, report.data.batchDir, out.exitCode));
		};
	}
}

export const specsVerifier = new SpecsVerifier();
