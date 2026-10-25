import { z } from "zod";

/** Failure of a React profiling step. The first three are the runtime's, the rest are the profiler's own. */
export type ReactErrorCode =
	| "rn_too_old"
	| "release_build"
	| "devtools_backend_missing"
	| "session_active"
	| "not_profiling"
	| "cdp_failed"
	| "invalid_data";

export type ReactError = { code: ReactErrorCode; message: string; hint?: string; owner?: string };

export type ReactResult<T> = { success: true; data: T } | { success: false; error: ReactError };

export const reactOk = <T>(data: T): ReactResult<T> => ({ success: true, data });

export function reactErr(code: ReactErrorCode, message: string, extra: { hint?: string; owner?: string } = {}) {
	const error: ReactError = {
		code,
		message,
		...(extra.hint === undefined ? {} : { hint: extra.hint }),
		...(extra.owner === undefined ? {} : { owner: extra.owner }),
	};
	return { success: false, error } as const;
}

/** What changed for one fiber in one commit (the DevTools change description, normalised). */
export const causesSchema = z.object({
	firstMount: z.boolean(),
	/** prop names whose value changed by identity */
	props: z.array(z.string()),
	state: z.boolean(),
	/** indices of the hooks that changed */
	hooks: z.array(z.number()),
	context: z.boolean(),
});
export type Causes = z.infer<typeof causesSchema>;

export const fiberRenderSchema = z.object({
	id: z.number(),
	name: z.string(),
	/** nearest component ancestor */
	parent: z.string().optional(),
	actualMs: z.number(),
	selfMs: z.number(),
	/** null = the runtime gave no change description */
	causes: causesSchema.nullable(),
	memo: z.boolean(),
	/** compiled by React Compiler (auto-memoised) */
	compiler: z.boolean(),
});
export type FiberRender = z.infer<typeof fiberRenderSchema>;

export const commitSchema = z.object({
	index: z.number(),
	root: z.string(),
	/** ms since profiling started, on the app's monotonic clock */
	startMs: z.number(),
	/** the device's wall clock at the commit: aligns with other capturers */
	wallMs: z.number(),
	durationMs: z.number(),
	effectMs: z.number(),
	passiveEffectMs: z.number(),
	/** components whose update scheduled this commit */
	updaters: z.array(z.string()),
	fibers: z.array(fiberRenderSchema),
});
export type Commit = z.infer<typeof commitSchema>;

/** `react/commits.json`. */
export const commitsFileSchema = z.object({
	version: z.literal(1),
	anchor: z.object({
		/** device `Date.now()` / `performance.now()` at start */
		startedWallMs: z.number(),
		startedPerfMs: z.number(),
		stoppedWallMs: z.number(),
		/** host `Date.now()` at start, when the caller knew it */
		hostWallMs: z.number().optional(),
	}),
	dev: z.boolean().optional(),
	commits: z.array(commitSchema),
	/** component name to where it is declared, as the runtime reported it (`_debugSource`) */
	sources: z.record(z.string(), z.object({ file: z.string(), line: z.number() })),
	warnings: z.array(z.string()),
});
export type CommitsFile = z.infer<typeof commitsFileSchema>;

export type CauseKind = "mount" | "context" | "state" | "props" | "parent" | "unknown";

/** Why a fiber rendered, most specific first. */
export function causeOf(fiber: FiberRender): CauseKind {
	const c = fiber.causes;
	if (c === null) return "unknown";
	if (c.firstMount) return "mount";
	if (c.context) return "context";
	if (c.state || c.hooks.length > 0) return "state";
	if (c.props.length > 0) return "props";
	return "parent";
}
