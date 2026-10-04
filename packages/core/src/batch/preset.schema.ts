import { z } from "zod";
import { appOptionSchema } from "../builds/app-option.schema";
import { parseDuration } from "../duration";
import { parsePortSpec } from "../ports";

export const duration = z
	.string()
	.min(1)
	.refine((v) => parseDuration(v).success, { message: "invalid duration (use e.g. 30s, 10m, 2h)" });

export const portSpec = z
	.string()
	.min(1)
	.refine((v) => parsePortSpec(v).success, { message: "invalid port spec (use <from>[:<span>], e.g. 8091:20)" });

/** `jobsFrom`: a file (relative to the preset's cwd), `-` for stdin, or `{ command }` whose stdout lines are the jobs. */
const jobsFromSchema = z.union([z.string().min(1), z.object({ command: z.string().min(1) }).strict()]);

/** `batches.<name>` in `warden.config.ts`: a saved `warden batch` invocation. */
export const batchPresetSchema = z
	.object({
		/** `projects[].name`: serve / jobs run in its root and `app` uses it */
		project: z.string().min(1).optional(),
		platform: z.enum(["ios", "android"]),
		count: z.number().int().min(1).optional(),
		max: z.number().int().min(0).optional(),
		profile: z.string().min(1).optional(),
		runtime: z.string().min(1).optional(),
		label: z.string().min(1).optional(),
		ttl: duration.optional(),
		wait: duration.optional(),
		ports: z.array(portSpec).optional(),
		/** install the project's app on every device first; `{ clean: true }` also uninstalls it first */
		app: appOptionSchema.optional(),
		retry: z.number().int().min(0).optional(),
		passes: z.number().int().min(1).optional(),
		/** added to the serve + job env */
		env: z.record(z.string(), z.string()).optional(),
		serve: z.string().min(1).optional(),
		serveReady: z.string().min(1).optional(),
		serveTimeout: duration.optional(),
		jobs: z.array(z.string().min(1)).min(1).optional(),
		jobsFrom: jobsFromSchema.optional(),
		record: z.string().min(1).optional(),
		logs: z.string().min(1).optional(),
		cmd: z.array(z.string()).min(1),
	})
	.strict()
	.refine((p) => p.jobs === undefined || p.jobsFrom === undefined, {
		message: "set at most one of jobs / jobsFrom",
		path: ["jobs"],
	});

export type BatchPresetConfig = z.infer<typeof batchPresetSchema>;

/** Preset names that would shadow the platform operand of `warden batch`. */
export const RESERVED_PRESET_NAMES: readonly string[] = ["ios", "android"];
