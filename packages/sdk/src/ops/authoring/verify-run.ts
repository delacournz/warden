import type { Suite } from "@delacour/warden-core/affected/affected";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import type { RecordVerify } from "../../contracts/record.schema";
import type { OpSession } from "../session";
import { authoringCommon } from "./common";
import type { VerifyInput, VerifyReport } from "./deps";

const NO_RUNNER = "no spec runner is configured (pass `authoring.verify` to the client, or stop with verify: false)";

/** Running the written spec and reporting the run. */
export class VerifyRun {
	/** A spec run as `--json` reports it (`verify`) plus every file worth reading when it failed. */
	describeRun(report: VerifyReport): { verify: RecordVerify; evidence: string[] } {
		return {
			evidence: [report.results, report.log, ...report.tests.flatMap((test) => test.evidence)],
			verify: {
				status: report.passed ? "passed" : "failed",
				exitCode: report.exitCode,
				outDir: report.outDir,
				log: report.log,
				results: report.results,
				tests: report.tests,
			},
		};
	}

	/** The failed tests and the files they left, to the host's side output (nothing when it has none). */
	printFailures(session: OpSession, report: VerifyReport, evidence: readonly string[]): void {
		const out = authoringCommon.depsOf(session).err;
		if (!out) return;
		const color = authoringCommon.colorOf(session);
		for (const test of report.tests.filter((candidate) => candidate.status !== "passed")) {
			out(color.red(`✗ ${test.title}${test.error ? `: ${test.error.split("\n")[0]}` : ""}`));
		}
		for (const path of evidence) out(`  ${color.dim(path)}`);
	}

	/** The spec run for a device: this device's identity, its Metro, and the spec at `specPath`. */
	verifyInputFor(session: OpSession, specPath: string, suite: Suite, outDir: string): VerifyInput {
		return {
			udid: session.device.id,
			platform: session.device.platform,
			deviceName: session.device.name,
			specPath,
			suite,
			outDir,
			metroUrl: session.state.read().metroUrl,
		};
	}

	/** Run the spec through the injected runner; a throw is a run that could not start. */
	async runSpec(session: OpSession, input: VerifyInput): Promise<Result<VerifyReport, string>> {
		const verify = authoringCommon.depsOf(session).verify;
		if (!verify) return resultFactory.err(NO_RUNNER);
		try {
			return await verify(input);
		} catch (error) {
			return resultFactory.err(error instanceof Error ? error.message : String(error));
		}
	}
}

export const verifyRun = new VerifyRun();
