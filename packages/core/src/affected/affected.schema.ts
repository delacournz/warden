import { z } from "zod";
import { appOptionSchema } from "../builds/app-option.schema";

const path = z.string().min(1);
const platform = z.enum(["ios", "android"]);

/** `e2e.<suite>.flows.<id|glob>`: what a flow covers and whether it gates. */
export const e2eFlowSchema = z
	.object({
		/** files the flow drives (screens / routes); everything they import, transitively, selects the flow */
		entries: z.array(path).default([]),
		/** extra globs that select the flow when a changed file matches */
		paths: z.array(path).default([]),
		/** default: inferred from the flow id (`-ios-` / `-android-`), else both */
		platforms: z.array(platform).min(1).optional(),
		/** overrides the suite's `maxDepth` */
		maxDepth: z.number().int().min(0).optional(),
		/** a failure fails `warden e2e`; false = reported only */
		required: z.boolean().optional(),
	})
	.strict();

/**
 * `e2e.<suite>` in `warden.config.json`: flows under `flowsDir`, how they map to source, how to run one.
 * Paths and globs are relative to the config file's directory.
 */
export const e2eSuiteSchema = z
	.object({
		flowsDir: path,
		/** per-flow command; `{flow}` `{flowPath}` `{udid}` `{worker}` `{seq}` are substituted */
		runner: z.array(z.string()).min(1),
		/** fallback tsconfig for files without a nearer one */
		tsconfig: path.optional(),
		/** file-based router dir (e.g. `apps/mobile/src/app`): `_layout` files above an entry are entries too */
		routerRoot: path.optional(),
		platform: platform.optional(),
		/** git ref changes are measured against (merge-base with HEAD) */
		base: z.string().min(1).default("main"),
		/** only import chains of at most this many hops from an entry select a flow (default: any length) */
		maxDepth: z.number().int().min(0).optional(),
		/** a change matching one of these selects every flow (lockfile, native dirs, bundler config…) */
		runAll: z.array(path).default([]),
		/** changes matching these never select anything (docs, unit tests…) */
		ignore: z.array(path).default([]),
		/** flow ids / globs that always run */
		always: z.array(path).default([]),
		/** a flow without entries/paths: run it every time, or only via runAll / always */
		unmapped: z.enum(["run", "skip"]).default("run"),
		/** a flow passes only after this many consecutive green runs on the same device */
		passes: z.number().int().min(1).default(1),
		retry: z.number().int().min(0).default(0),
		count: z.number().int().min(1).optional(),
		profile: z.string().min(1).optional(),
		/** install the project's app on each device first (`warden batch --app`); `{ clean: true }` = `--clean` */
		app: appOptionSchema.optional(),
		/** default `required` for flows that don't set it */
		required: z.boolean().default(true),
		flows: z.record(z.string().min(1), e2eFlowSchema).default({}),
	})
	.strict();

export type E2eFlowConfig = z.infer<typeof e2eFlowSchema>;
export type E2eSuiteConfig = z.infer<typeof e2eSuiteSchema>;
