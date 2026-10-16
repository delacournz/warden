import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import type { TestStatus } from "../../results/schema";

/** One jest test as detox's runner reports it. */
export type JestTest = { nativeName: string; status: TestStatus; durationMs: number; error?: string };

const assertionSchema = z.object({
	title: z.string(),
	status: z.string(),
	duration: z.number().nullable().optional(),
	failureMessages: z.array(z.string()).optional(),
});

const jestJsonSchema = z.object({
	testResults: z.array(
		z.object({
			name: z.string().optional(),
			message: z.string().optional(),
			assertionResults: z.array(assertionSchema).default([]),
		})
	),
});

const statusOf = (jest: string): TestStatus => {
	if (jest === "passed") return "passed";
	if (jest === "failed") return "failed";
	return "skipped";
};

type Assertion = z.infer<typeof assertionSchema>;

const toTest = (a: Assertion): JestTest => {
	const failure = a.failureMessages?.find((m) => m !== "");
	return {
		nativeName: a.title,
		status: statusOf(a.status),
		durationMs: a.duration ?? 0,
		...(failure !== undefined ? { error: failure } : {}),
	};
};

/**
 * Parses `jest --json` output (what `detox test -- --json --outputFile` writes). Only `title` is used as the
 * native name (the manifest's detox column), not `fullName`, which is prefixed by the describe block. A test file
 * that crashed before any test ran (globalSetup / attach failure) has no assertions: that is an error carrying
 * jest's message so the adapter can classify it.
 */
export function parseJestJson(text: string): Result<JestTest[]> {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (e) {
		return err(`jest json is not JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	const parsed = jestJsonSchema.safeParse(json);
	if (!parsed.success) return err(`unexpected jest json: ${parsed.error.issues[0]?.message ?? "invalid"}`);
	for (const file of parsed.data.testResults) {
		if (file.assertionResults.length === 0 && file.message)
			return err(`${file.name ?? "test file"} did not run: ${file.message}`);
	}
	return ok(parsed.data.testResults.flatMap((f) => f.assertionResults.map(toTest)));
}
