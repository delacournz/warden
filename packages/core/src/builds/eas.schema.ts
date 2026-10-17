/**
 * The zod schemas of eas-cli's JSON output. `eas.ts` loads this module on its first parse, not at import: zod is ~95
 * modules that `warden run` / `dev` / `app` would otherwise load at start (15-2).
 */
import { z } from "zod";

export const easBuildStatusSchema = z.enum([
	"NEW",
	"IN_QUEUE",
	"IN_PROGRESS",
	"PENDING_CANCEL",
	"ERRORED",
	"FINISHED",
	"CANCELED",
]);

/** The slice of eas-cli's `BuildFragment` (`eas build:list --json`) warden reads. */
export const easBuildSchema = z.object({
	id: z.string(),
	status: easBuildStatusSchema,
	createdAt: z.string(),
	platform: z.string().nullish(),
	isForIosSimulator: z.boolean().nullish(),
	artifacts: z.object({ applicationArchiveUrl: z.string().nullish() }).nullish(),
});

export const easBuildListSchema = z.array(easBuildSchema);

/** `eas build:download --json` prints `{ path }`. */
export const easDownloadSchema = z.object({ path: z.string().min(1) });
