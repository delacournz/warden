import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

export const testStatusSchema = z.enum(["passed", "failed", "skipped", "timed-out"]);

export const testResultSchema = z.object({
	/** absolute path of the spec file */
	file: z.string(),
	/** describe titles then the test title */
	title: z.array(z.string()),
	status: testStatusSchema,
	durationMs: z.number(),
	/** epoch ms */
	startedAt: z.number(),
	only: z.boolean().optional(),
	error: z
		.object({
			message: z.string(),
			code: z.string().optional(),
			stack: z.string().optional(),
		})
		.optional(),
	/** the attempt dir (`artifacts.attemptDir`) and the files written into it, relative to it */
	artifacts: z.object({ dir: z.string(), files: z.array(z.string()) }).optional(),
	device: z.object({
		udid: z.string(),
		platform: z.enum(["ios", "android"]),
		name: z.string().optional(),
	}),
});

export type TestResult = z.infer<typeof testResultSchema>;
export type TestStatus = z.infer<typeof testStatusSchema>;

export type ResultsWriter = {
	readonly path: string;
	/** one JSON line; `appendFileSync` so a crash right after never loses an earlier line */
	append(result: TestResult): void;
};

/** Append-only `results.jsonl` writer; the directory is created on first use. */
export function openResults(path: string): ResultsWriter {
	let ready = false;
	return {
		path,
		append(result) {
			if (!ready) {
				mkdirSync(dirname(path), { recursive: true });
				ready = true;
			}
			appendFileSync(path, `${JSON.stringify(result)}\n`);
		},
	};
}

/** Valid results in file order. Blank, truncated (killed mid-write) and invalid lines are skipped. */
export function readResults(text: string): TestResult[] {
	const results: TestResult[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		let json: unknown;
		try {
			json = JSON.parse(line);
		} catch {
			continue;
		}
		const parsed = testResultSchema.safeParse(json);
		if (parsed.success) results.push(parsed.data);
	}
	return results;
}
