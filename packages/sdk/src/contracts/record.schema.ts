import { z } from "zod";

/**
 * `result` of `warden ui record <start|note|undo|status|cancel|use|stop> --json`, discriminated on `outcome`. The
 * authoring ops (`ops/authoring/*`) annotate their results with these types, so the CLI and the SDK cannot drift.
 */

const targetKindSchema = z.enum(["spec", "helper"]);

export const recordLintSchema = z.object({
	level: z.enum(["warn", "error"]),
	step: z.number().nullable(),
	code: z.enum([
		"coords_target",
		"text_only_selector",
		"unverified_navigation",
		"ambiguous_selector",
		"empty_recording",
	]),
	message: z.string(),
	hint: z.string(),
});
export type RecordLint = z.infer<typeof recordLintSchema>;

const stepSummarySchema = z.object({ i: z.number(), summary: z.string() });

export const recordStartedSchema = z.object({
	outcome: z.literal("started"),
	name: z.string(),
	kind: targetKindSchema,
	target: z.string(),
	fn: z.string().optional(),
	ids: z.string().optional(),
	journal: z.string(),
});

export const recordNotedSchema = z.object({ outcome: z.literal("noted"), step: z.number(), text: z.string() });

export const recordUndoneSchema = z.object({
	outcome: z.literal("undone"),
	removed: z.array(stepSummarySchema),
	steps: z.number().nullable(),
});

export const recordIdleSchema = z.object({ outcome: z.literal("idle"), recording: z.null() });

export const recordStatusSchema = z.object({
	outcome: z.literal("recording"),
	recording: z.object({
		name: z.string(),
		title: z.string().nullable(),
		kind: targetKindSchema,
		target: z.string(),
		startedAt: z.number(),
		steps: z.number(),
		last: z.array(stepSummarySchema.extend({ kind: z.string() })),
		lints: z.array(recordLintSchema),
	}),
});

export const recordCancelledSchema = z.object({
	outcome: z.literal("cancelled"),
	name: z.string(),
	steps: z.number().nullable(),
	kept: z.string().optional(),
});

/** The `specs.<id>` proposal `record stop` prints for `warden.config.ts`. */
export const recordSpecConfigSchema = z.object({
	id: z.string(),
	suite: z.string().optional(),
	snippet: z.string(),
	entries: z.array(z.string()),
	routes: z.array(z.string()),
	unresolved: z.array(z.string()),
	captured: z.boolean(),
	hints: z.array(z.string()),
});
export type RecordSpecConfig = z.infer<typeof recordSpecConfigSchema>;

const verifyTestSchema = z.object({
	title: z.string(),
	status: z.enum(["passed", "failed", "skipped", "timed-out"]),
	durationMs: z.number(),
	error: z.string().optional(),
	evidence: z.array(z.string()),
});

/** The spec run `record stop` and `record use` make on the device. */
export const recordVerifySchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("skipped"), reason: z.enum(["helper", "flag"]) }),
	z.object({
		status: z.enum(["passed", "failed"]),
		exitCode: z.number(),
		outDir: z.string(),
		log: z.string(),
		results: z.string(),
		tests: z.array(verifyTestSchema),
	}),
]);
export type RecordVerify = z.infer<typeof recordVerifySchema>;

export const recordStoppedSchema = z.object({
	outcome: z.enum(["verified", "written"]),
	kind: targetKindSchema,
	name: z.string(),
	file: z.string(),
	fn: z.string().optional(),
	replaced: z.boolean().optional(),
	steps: z.number(),
	ids: z.object({ file: z.string(), added: z.record(z.string(), z.string()) }).nullable(),
	lints: z.array(recordLintSchema),
	fixmes: z.number(),
	config: recordSpecConfigSchema.nullable(),
	options: z.object({ module: z.string(), name: z.string() }).nullable().optional(),
	launch: z.enum(["none", "fresh"]).optional(),
	verify: recordVerifySchema,
});

export const recordUsedSchema = z.object({
	outcome: z.literal("used"),
	step: z.number(),
	module: z.string(),
	fn: z.string(),
	route: z.string().optional(),
	visited: z.array(z.string()),
	routes: z.enum(["reads", "recording"]),
	verify: recordVerifySchema,
});

/** Any `ui record * --json` result. */
export const recordResultSchema = z.union([
	recordStartedSchema,
	recordNotedSchema,
	recordUndoneSchema,
	recordIdleSchema,
	recordStatusSchema,
	recordCancelledSchema,
	recordStoppedSchema,
	recordUsedSchema,
]);

export type RecordStarted = z.infer<typeof recordStartedSchema>;
export type RecordNoted = z.infer<typeof recordNotedSchema>;
export type RecordUndone = z.infer<typeof recordUndoneSchema>;
export type RecordIdle = z.infer<typeof recordIdleSchema>;
export type RecordStatus = z.infer<typeof recordStatusSchema>;
export type RecordCancelled = z.infer<typeof recordCancelledSchema>;
export type RecordStopped = z.infer<typeof recordStoppedSchema>;
export type RecordUsed = z.infer<typeof recordUsedSchema>;
export type RecordResult = z.infer<typeof recordResultSchema>;
