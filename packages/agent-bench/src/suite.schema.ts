import { z } from "zod";

/** The model a suite runs on unless it names another (plan decision: the bench measures a mid-size model). */
export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** The pinned bench app every suite drives (`packages/e2e-bench`'s `.bench/app/<platform>/`). */
export const APPS = ["example"] as const;

const ISSTATES = ["visible", "hittable", "enabled", "checked", "selected", "focused"] as const;

/**
 * One assertion run after the agent finishes, through this checkout's `warden ui` on the bench's device.
 * `wait`: the selector appears within `timeoutMs`. `absent`: it is gone. `is`: the element has `state`.
 */
export const successCheckSchema = z.union([
	z.strictObject({ wait: z.string().min(1), timeoutMs: z.number().int().positive().optional() }),
	z.strictObject({ absent: z.string().min(1), timeoutMs: z.number().int().positive().optional() }),
	z.strictObject({ is: z.string().min(1), state: z.enum(ISSTATES) }),
]);
export type SuccessCheck = z.infer<typeof successCheckSchema>;

/** The numbers a run is diffed against; refreshed by hand from a run the team agrees is representative. */
export const baselineSchema = z.strictObject({
	toolCalls: z.number().int().nonnegative(),
	wardenCalls: z.number().int().nonnegative(),
	stumbles: z.number().int().nonnegative(),
	wallMs: z.number().int().nonnegative(),
});
export type Baseline = z.infer<typeof baselineSchema>;

export const suiteSchema = z.strictObject({
	name: z.string().regex(/^[a-z0-9-]+$/),
	description: z.string().min(1),
	/** the prompt file, relative to the suite file; `{{udid}}`, `{{platform}}` and `{{bundleId}}` are filled in */
	prompt: z.string().min(1),
	platform: z.enum(["ios", "android"]).default("ios"),
	app: z.enum(APPS).default("example"),
	model: z.string().min(1).default(DEFAULT_MODEL),
	/** passed to `claude --allowedTools`; anything else is denied (`--permission-mode dontAsk`) */
	allowedTools: z.array(z.string().min(1)).min(1),
	/** assistant turns before the bench stops the agent (counted from the stream, then the process is killed) */
	maxTurns: z.number().int().positive(),
	/** wall-clock budget for the agent; the process group is killed after it */
	timeoutMs: z.number().int().positive().default(600_000),
	/** spend cap passed to `claude --max-budget-usd` */
	maxBudgetUsd: z.number().positive().optional(),
	baseline: baselineSchema.optional(),
	/** warden error codes counted in tool results (`stale_ref`, `E_TIMEOUT`, `target_not_found`, …) */
	failurePatterns: z.array(z.string().min(1)).default([]),
	success: z.array(successCheckSchema).min(1),
});
export type Suite = z.infer<typeof suiteSchema>;
