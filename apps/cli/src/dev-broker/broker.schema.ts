import { z } from "zod";

const consoleLevelSchema = z.enum(["log", "info", "warn", "error", "debug"]);

/** `status` is a code (`404`) or a class (`4xx`). */
const statusFilterSchema = z.union([z.number().int(), z.string().regex(/^[1-5]xx$/)]);

export const consoleQuerySchema = z.strictObject({
	/** epoch ms: only lines at or after it */
	since: z.number().optional(),
	level: consoleLevelSchema.optional(),
	/** case-insensitive substring of the line text */
	grep: z.string().optional(),
	/** the newest n matches (default 200) */
	limit: z.number().int().positive().optional(),
	kind: z.enum(["console", "exception", "note"]).optional(),
});

export const exceptionsQuerySchema = z.strictObject({
	since: z.number().optional(),
	limit: z.number().int().positive().optional(),
});

export const networkQuerySchema = z.strictObject({
	since: z.number().optional(),
	/** case-insensitive substring of the URL */
	urlGrep: z.string().optional(),
	status: statusFilterSchema.optional(),
	limit: z.number().int().positive().optional(),
});

export const evalParamsSchema = z.strictObject({
	expression: z.string().min(1),
	timeoutMs: z.number().int().positive().optional(),
});

export const treeParamsSchema = z.strictObject({
	/** nesting levels kept below the root of the selection */
	depth: z.number().int().nonnegative().optional(),
	/** only the subtree of the component(s) with this testID */
	testID: z.string().optional(),
});

export const noParamsSchema = z.strictObject({});

/** The envelope of one line on the socket. */
export const wireRequestSchema = z.object({
	id: z.string(),
	method: z.string(),
	params: z.unknown().optional(),
});
