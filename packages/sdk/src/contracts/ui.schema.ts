import { WARDEN_ERROR_CODES } from "@delacour/warden-types/error";
import { z } from "zod";
import { platformSchema } from "./primitives.schema";

export const uiDeviceInfoSchema = z.object({ udid: z.string(), platform: platformSchema, name: z.string().optional() });
export type UiDeviceInfoJson = z.infer<typeof uiDeviceInfoSchema>;

export const wardenErrorSchema = z.object({
	code: z.enum(WARDEN_ERROR_CODES),
	message: z.string(),
	hint: z.string().optional(),
	details: z.record(z.string(), z.unknown()).optional(),
	retryable: z.boolean().optional(),
});

/** `warden ui <command> --json` on success. `result` is the command's own schema (`uiFindResultSchema`, …). */
export const uiOkSchema = z.object({
	ok: z.literal(true),
	command: z.string(),
	device: uiDeviceInfoSchema,
	generation: z.number().optional(),
	durationMs: z.number(),
	/** the caller's `warden dev` lease this call used beside it (shared, not taken over; `close --release` keeps it) */
	attachedTo: z.string().optional(),
	result: z.unknown(),
	warnings: z.array(z.string()).optional(),
});

/** `warden ui <command> --json` on failure. */
export const uiErrSchema = z.object({
	ok: z.literal(false),
	command: z.string(),
	device: uiDeviceInfoSchema.optional(),
	error: wardenErrorSchema,
});

/** The one document `warden ui … --json` prints, success or failure. */
export const uiJsonSchema = z.discriminatedUnion("ok", [uiOkSchema, uiErrSchema]);
export type UiJsonDoc = z.infer<typeof uiJsonSchema>;

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/** One element of a snapshot / find result. */
export const elementJsonSchema = z.object({
	ref: z.string().optional(),
	role: z.string(),
	name: z.string().optional(),
	id: z.string().optional(),
	value: z.string().optional(),
	enabled: z.boolean(),
	hittable: z.boolean().optional(),
	selected: z.boolean().optional(),
	checked: z.boolean().optional(),
	frame: rectSchema,
	/** an interactive element without a testID (only set while a recording is active) */
	noId: z.literal(true).optional(),
});
export type ElementJsonDoc = z.infer<typeof elementJsonSchema>;

/** `result` of `warden ui find`. */
export const uiFindResultSchema = z.object({
	/** `generation`, `header` and `lines` are the text rendering; the `--json` result carries only `elements` and `count` */
	generation: z.number().optional(),
	header: z.string().optional(),
	lines: z.array(z.string()).optional(),
	elements: z.array(elementJsonSchema),
	count: z.number(),
});
export type UiFindResult = z.infer<typeof uiFindResultSchema>;

/** `result` of `warden ui close`. */
export const uiCloseResultSchema = z.object({
	app: z.string().nullable(),
	helper: z.object({ stopped: z.boolean(), how: z.string(), warning: z.string().optional() }),
	released: z.boolean(),
});
export type UiCloseResult = z.infer<typeof uiCloseResultSchema>;
