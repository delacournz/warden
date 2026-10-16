import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import type { StepResult, TestResult } from "../../results/schema";

/** One test from `report.json`, before the manifest maps its name to a canonical id. */
export type TesterNative = {
	nativeName: string;
	status: TestResult["status"];
	durationMs: number;
	error?: string;
	steps: StepResult[];
};

const errorSchema = z.object({ message: z.string().optional(), code: z.string().optional() }).passthrough();

const stepSchema = z
	.object({
		kind: z.string(),
		api: z.string(),
		label: z.string(),
		status: z.string(),
		durationMs: z.number(),
	})
	.passthrough();

const attemptSchema = z
	.object({
		status: z.string(),
		durationMs: z.number(),
		steps: z.array(stepSchema).default([]),
		error: errorSchema.optional(),
	})
	.passthrough();

const resultSchema = z
	.object({
		kind: z.string().optional(),
		titlePath: z.array(z.string()),
		status: z.string(),
		attempts: z.array(attemptSchema).default([]),
	})
	.passthrough();

const reportSchema = z.object({
	schemaVersion: z.literal("report-1"),
	run: z.object({ results: z.array(resultSchema) }).passthrough(),
});

/** tester.army's result status → the bench status (a test that passed on a retry is flaky: still a pass). */
export function testStatus(status: string): TestResult["status"] {
	switch (status) {
		case "passed":
		case "flaky":
			return "passed";
		case "timed-out":
			return "timed-out";
		case "skipped":
			return "skipped";
		default:
			return "failed";
	}
}

/** A step's status in the bench's three-value vocabulary (blocked / timed-out count as failed). */
export function stepStatus(status: string): StepResult["status"] {
	if (status === "passed") return "passed";
	if (status === "cancelled" || status === "skipped") return "skipped";
	return "failed";
}

/** `titlePath` joined by a space: what the `list` reporter prints and what `--grep` matches. */
export const nativeNameOf = (titlePath: readonly string[]): string => titlePath.join(" ");

type ReportResult = z.infer<typeof resultSchema>;

/**
 * Duration, steps and error of the attempt that decided the result (the last one): earlier attempts
 * only exist with retries, and the bench runs with none.
 */
function fromAttempts(result: ReportResult): Pick<TesterNative, "durationMs" | "steps" | "error"> {
	const last = result.attempts.at(-1);
	if (last === undefined) return { durationMs: 0, steps: [] };
	const message = last.error?.message;
	return {
		durationMs: last.durationMs,
		steps: last.steps.map((s) => ({ kind: s.api, label: s.label, ms: s.durationMs, status: stepStatus(s.status) })),
		...(message !== undefined ? { error: message } : {}),
	};
}

/** `report.json` text → native tests, in report order. Setup results (hooks) are not tests. */
export function parseTesterReport(text: string): Result<TesterNative[]> {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (e) {
		return err(`report.json is not JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	const parsed = reportSchema.safeParse(json);
	if (!parsed.success)
		return err(`report.json: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
	const tests = parsed.data.run.results
		.filter((r) => r.kind === undefined || r.kind === "test")
		.map(
			(r): TesterNative => ({
				nativeName: nativeNameOf(r.titlePath),
				status: testStatus(r.status),
				...fromAttempts(r),
			})
		);
	return ok(tests);
}
