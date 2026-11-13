import { type CapacityReason, CLAIM_ERRORS, type ClaimErrorCode } from "@delacour/warden-core/claim-errors";
import { z } from "zod";
import { UI_ERROR_EXIT, type UiErrorCode } from "../agent-ui/output";
import { SCHEMA_VERSIONS, type SchemaName } from "./versions";

/** `schemaVersion: <N>` of a schema, as a literal. */
export function versionOf(name: SchemaName) {
	return z.literal(SCHEMA_VERSIONS[name]);
}

export const platformSchema = z.enum(["ios", "android"]);

export const rectSchema = z.strictObject({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
export const pointSchema = z.strictObject({ x: z.number(), y: z.number() });

const CLAIM_CODES = Object.keys(CLAIM_ERRORS) as [ClaimErrorCode, ...ClaimErrorCode[]];
const CAPACITY_REASONS = ["ram-budget", "cpu-budget", "memory-pressure", "host-load"] as const satisfies readonly [
	CapacityReason,
	...CapacityReason[],
];
const UI_ERROR_CODES = Object.keys(UI_ERROR_EXIT) as [UiErrorCode, ...UiErrorCode[]];

/** A lease as `claim` (and `run`) report it. */
export const claimedLeaseSchema = z.strictObject({
	leaseId: z.string(),
	platform: platformSchema,
	udid: z.string(),
	name: z.string(),
	action: z.enum(["reuse", "boot", "create"]),
	ttlMs: z.number(),
	physical: z.strictObject({ transport: z.string(), hwSerial: z.string().optional() }).optional(),
	label: z.string().optional(),
});

/** The error of a failed `--json` run that left stdout empty (`command.ts` `JsonFailure`). */
export const failureErrorSchema = z.union([
	z.strictObject({ code: z.enum(["usage", "failed"]), message: z.string() }),
	z.strictObject({
		message: z.string(),
		code: z.literal("ambiguous_device"),
		hint: z.string(),
		details: z.record(z.string(), z.unknown()),
	}),
	z.strictObject({ message: z.string(), code: z.literal("device_locked"), hint: z.string() }),
	z.strictObject({
		message: z.string(),
		code: z.literal("NO_CAPACITY"),
		capacityReason: z.enum(CAPACITY_REASONS),
		hint: z.string(),
	}),
	z.strictObject({
		message: z.string(),
		code: z.enum(CLAIM_CODES).exclude(["NO_CAPACITY"]),
		hint: z.string(),
	}),
]);

/** What every failed `--json` run prints when the command itself wrote nothing. */
export const failureSchema = z.strictObject({
	ok: z.literal(false),
	schemaVersion: versionOf("warden.failure"),
	command: z.string(),
	error: failureErrorSchema,
});

/** A `warden ui` / `warden perf` error. */
export const uiErrorSchema = z.strictObject({
	code: z.enum(UI_ERROR_CODES),
	message: z.string(),
	hint: z.string().optional(),
	details: z.record(z.string(), z.unknown()).optional(),
});

export const uiDeviceSchema = z.strictObject({
	udid: z.string(),
	platform: platformSchema,
	name: z.string().optional(),
});

/** The `ok: false` envelope of `warden ui` (any verb). */
export const uiFailureSchema = z.strictObject({
	ok: z.literal(false),
	schemaVersion: versionOf("warden.ui"),
	command: z.string(),
	device: uiDeviceSchema.optional(),
	error: uiErrorSchema,
});

/** The `ok: true` envelope of `warden ui <command>` around that verb's `result`. */
export function uiOkSchema<C extends string, R extends z.ZodType>(command: C, result: R) {
	return z.strictObject({
		ok: z.literal(true),
		schemaVersion: versionOf("warden.ui"),
		command: z.literal(command),
		device: uiDeviceSchema,
		generation: z.number().optional(),
		durationMs: z.number(),
		attachedTo: z.string().optional(),
		result,
		warnings: z.array(z.string()).optional(),
	});
}

/** A verb's whole `--json` document: its success envelope, or the failure envelope. */
export function uiDocSchema<C extends string, R extends z.ZodType>(command: C, result: R) {
	return z.union([uiOkSchema(command, result), uiFailureSchema]);
}

export type FailureJson = z.infer<typeof failureSchema>;
export type UiErrorJson = z.infer<typeof uiErrorSchema>;
