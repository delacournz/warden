import { z } from "zod";
import { versionOf } from "./common.schema";

/** `warden release --json`. */
export const releaseSchema = z.strictObject({
	schemaVersion: versionOf("warden.release"),
	released: z.array(z.string()),
	shutdown: z.array(z.string()),
	deleted: z.array(z.string()),
	quarantined: z.array(z.string()),
	/** ids / udids that matched no lease (exit 1) */
	unknown: z.array(z.string()),
	notes: z.array(z.string()),
});

export type ReleaseJson = z.infer<typeof releaseSchema>;
