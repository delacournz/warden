import { err, ok, type Result } from "@delacour/warden-types/result";
import { z } from "zod";
import type { StepResult, TestResult } from "../../results/schema";

const stepSchema = z.object({
	kind: z.string(),
	status: z.string(),
	target: z.string().optional(),
	tool: z.string().optional(),
	reason: z.string().optional(),
	durationMs: z.number().optional(),
});

const reportSchema = z.object({
	flow: z.string(),
	ok: z.boolean(),
	durationMs: z.number().optional(),
	steps: z.array(stepSchema),
});

const flowEntrySchema = z.object({
	path: z.string(),
	status: z.string(),
	report: reportSchema.optional(),
	error: z.string().optional(),
});

/** `argent flow run <dir> --json`: the directory aggregate. */
const aggregateSchema = z.object({ flows: z.array(flowEntrySchema) });

/** One flow as argent reported it, before the manifest join. */
export type ArgentFlow = {
	/** the report's `flow` field (the file name minus `.yaml`); the file name when the flow never produced a report */
	nativeName: string;
	status: TestResult["status"];
	durationMs: number | undefined;
	steps: StepResult[];
	error: string | undefined;
};

type ArgentStep = z.infer<typeof stepSchema>;

function stepStatus(status: string): StepResult["status"] {
	if (status === "pass") return "passed";
	if (status === "skip") return "skipped";
	return "failed";
}

function toStep(s: ArgentStep): StepResult {
	return { kind: s.kind, label: s.target ?? s.tool ?? s.kind, ms: s.durationMs ?? 0, status: stepStatus(s.status) };
}

function baseName(path: string): string {
	const file = path.split("/").pop() ?? path;
	return file.replace(/\.ya?ml$/, "");
}

function firstFailure(steps: readonly ArgentStep[]): string | undefined {
	const bad = steps.find((s) => s.status === "fail" || s.status === "error");
	if (bad === undefined) return undefined;
	return `${bad.kind}${bad.target ? ` ${bad.target}` : ""}: ${bad.reason ?? bad.status}`;
}

function toFlow(entry: z.infer<typeof flowEntrySchema>): ArgentFlow {
	const report = entry.report;
	if (report === undefined)
		return {
			nativeName: baseName(entry.path),
			status: "failed",
			durationMs: undefined,
			steps: [],
			error: entry.error ?? `argent reported ${entry.status} with no report`,
		};
	return {
		nativeName: report.flow,
		status: report.ok ? "passed" : "failed",
		durationMs: report.durationMs,
		steps: report.steps.map(toStep),
		error: report.ok ? undefined : firstFailure(report.steps),
	};
}

/** Parses the `--json` aggregate of a directory run into one `ArgentFlow` per flow file. */
export function parseArgentAggregate(text: string): Result<ArgentFlow[], string> {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (e) {
		return err(`argent output is not JSON: ${e instanceof Error ? e.message : String(e)}`);
	}
	const parsed = aggregateSchema.safeParse(json);
	if (!parsed.success)
		return err(`argent aggregate has an unexpected shape: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
	return ok(parsed.data.flows.map(toFlow));
}
