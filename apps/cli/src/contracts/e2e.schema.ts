import { testResultSchema } from "@delacour/warden-e2e/runner/results";
import { z } from "zod";
import { platformSchema, versionOf } from "./common.schema";

const testStatusSchema = z.enum(["passed", "failed", "skipped", "timed-out"]);

/** Why a spec was selected; paths are relative to the config dir. */
const reasonSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("run-all"), file: z.string(), pattern: z.string() }),
	z.strictObject({ kind: z.literal("path"), file: z.string(), pattern: z.string() }),
	z.strictObject({ kind: z.literal("import"), file: z.string(), chain: z.array(z.string()) }),
	z.strictObject({ kind: z.literal("spec-file"), file: z.string() }),
	z.strictObject({ kind: z.literal("always"), pattern: z.string() }),
	z.strictObject({ kind: z.literal("unmapped") }),
	z.strictObject({ kind: z.literal("all") }),
	z.strictObject({ kind: z.literal("requested"), pattern: z.string() }),
	z.strictObject({ kind: z.literal("unmatched"), file: z.string() }),
]);

/** One test of a spec's last attempt. */
const testVerdictSchema = z.strictObject({
	title: z.array(z.string()),
	status: testStatusSchema,
	durationMs: z.number(),
	error: z.string().optional(),
	line: z.number().optional(),
	artifacts: z.string().optional(),
	perf: z.string().optional(),
	kind: z.literal("perf_budget").optional(),
});

/** One spec's outcome. */
const specVerdictSchema = z.strictObject({
	id: z.string(),
	file: z.string(),
	required: z.boolean(),
	reasons: z.array(reasonSchema),
	leg: z.string().optional(),
	verdict: z.enum(["passed", "failed", "not-run"]),
	attempts: z.number(),
	tests: z.array(testVerdictSchema).optional(),
	device: z.strictObject({ udid: z.string(), name: z.string() }).optional(),
	log: z.string().optional(),
	screenshot: z.string().optional(),
});

const deviceSetupSchema = z.strictObject({
	worker: z.number(),
	udid: z.string(),
	ok: z.boolean(),
	exitCode: z.number().optional(),
	log: z.string().optional(),
	slim: z.union([z.strictObject({ jobs: z.number() }), z.strictObject({ error: z.string() })]).optional(),
	error: z.string().optional(),
});

const axRecoverySchema = z.discriminatedUnion("outcome", [
	z.strictObject({ outcome: z.literal("recovered") }),
	z.strictObject({ outcome: z.literal("rebooted") }),
	z.strictObject({
		outcome: z.literal("failed"),
		error: z.string(),
		stage: z.enum(["log", "restart", "reboot"]).optional(),
	}),
]);

const deviceWarmSchema = z.strictObject({
	worker: z.number(),
	udid: z.string(),
	ok: z.boolean(),
	error: z.string().optional(),
	axRecovery: axRecoverySchema.optional(),
	dropped: z.literal(true).optional(),
	quarantined: z.literal(true).optional(),
});

/** `warden e2e --json`, the last `--json-lines` event's `report`, and `<batchDir>/e2e-report.json`. */
export const e2eReportSchema = z.strictObject({
	schemaVersion: versionOf("warden.e2e.report"),
	suite: z.string(),
	platform: platformSchema,
	base: z.string().optional(),
	isolate: z.enum(["device", "spec"]),
	ok: z.boolean(),
	headless: z.boolean(),
	batchDir: z.string().optional(),
	specs: z.array(specVerdictSchema),
	only: z.array(z.string()).optional(),
	setup: z.array(deviceSetupSchema).optional(),
	warm: z.array(deviceWarmSchema).optional(),
	error: z.strictObject({ code: z.string(), message: z.string(), udid: z.string() }).optional(),
	timing: z
		.strictObject({ totalMs: z.number(), setupMs: z.number(), testsMs: z.number(), teardownMs: z.number() })
		.optional(),
});

/** One `warden e2e --json-lines` line: a test as it finishes, then the report once the run is over. */
export const e2eEventSchema = z.discriminatedUnion("event", [
	z.strictObject({
		schemaVersion: versionOf("warden.e2e.event"),
		event: z.literal("test"),
		spec: z.string(),
		file: z.string(),
		title: z.array(z.string()),
		status: testStatusSchema,
		durationMs: z.number(),
		error: z.string().optional(),
		code: z.string().optional(),
		line: z.number().optional(),
		artifacts: z.string().optional(),
		device: z.strictObject({ udid: z.string(), name: z.string().optional() }),
	}),
	z.strictObject({
		schemaVersion: versionOf("warden.e2e.event"),
		event: z.literal("report"),
		report: e2eReportSchema,
	}),
]);

/**
 * One line of `<attempt>/results.jsonl`, written by the spec runtime. Versioned in the registry only: the lines
 * carry no `schemaVersion` (the runtime that writes them ships apart from the CLI that reads them).
 */
export const e2eResultSchema = testResultSchema;

export type E2eReportJson = z.infer<typeof e2eReportSchema>;
export type E2eEventJson = z.infer<typeof e2eEventSchema>;
