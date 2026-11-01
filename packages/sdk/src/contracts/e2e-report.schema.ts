import { z } from "zod";
import { platformSchema } from "./primitives.schema";

export const testStatusSchema = z.enum(["passed", "failed", "skipped", "timed-out"]);

const reasonSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("run-all"), file: z.string(), pattern: z.string() }),
	z.object({ kind: z.literal("path"), file: z.string(), pattern: z.string() }),
	z.object({ kind: z.literal("import"), file: z.string(), chain: z.array(z.string()) }),
	z.object({ kind: z.literal("spec-file"), file: z.string() }),
	z.object({ kind: z.literal("always"), pattern: z.string() }),
	z.object({ kind: z.literal("unmapped") }),
	z.object({ kind: z.literal("all") }),
	z.object({ kind: z.literal("requested"), pattern: z.string() }),
	z.object({ kind: z.literal("unmatched"), file: z.string() }),
]);

export const testVerdictSchema = z.object({
	title: z.array(z.string()),
	status: testStatusSchema,
	durationMs: z.number(),
	error: z.string().optional(),
	artifacts: z.string().optional(),
	/** `device.perf` / `--perf` wrote a report: `<artifacts>/perf` */
	perf: z.string().optional(),
	/** the test failed because a perf metric was over its budget */
	kind: z.literal("perf_budget").optional(),
});

export const specVerdictSchema = z.object({
	id: z.string(),
	file: z.string(),
	required: z.boolean(),
	reasons: z.array(reasonSchema),
	leg: z.string().optional(),
	verdict: z.enum(["passed", "failed", "not-run"]),
	attempts: z.number(),
	tests: z.array(testVerdictSchema).optional(),
	device: z.object({ udid: z.string(), name: z.string() }).optional(),
	log: z.string().optional(),
	screenshot: z.string().optional(),
});

export const deviceSetupSchema = z.object({
	worker: z.number(),
	udid: z.string(),
	ok: z.boolean(),
	exitCode: z.number().optional(),
	log: z.string().optional(),
	slim: z.union([z.object({ jobs: z.number() }), z.object({ error: z.string() })]).optional(),
	error: z.string().optional(),
});

/** `e2e-report.json` (and `warden e2e --json`). */
export const e2eReportSchema = z.object({
	suite: z.string(),
	platform: platformSchema,
	base: z.string().optional(),
	isolate: z.enum(["device", "spec"]),
	mode: z.literal("single").optional(),
	ok: z.boolean(),
	headless: z.boolean(),
	batchDir: z.string().optional(),
	specs: z.array(specVerdictSchema),
	only: z.array(z.string()).optional(),
	setup: z.array(deviceSetupSchema).optional(),
	/** the run stopped before any spec: a phone's runner would not start (`device_locked`, ...) */
	error: z.object({ code: z.string(), message: z.string(), udid: z.string() }).optional(),
});
export type E2eReportJson = z.infer<typeof e2eReportSchema>;
