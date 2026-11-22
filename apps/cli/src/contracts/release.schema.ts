import { z } from "zod";
import { versionOf } from "./common.schema";

/** `warden release --json`. */
export const releaseSchema = z.strictObject({
	schemaVersion: versionOf("warden.release"),
	released: z.array(z.string()),
	shutdown: z.array(z.string()),
	/** hosted (warden cloud) device ids stopped */
	remoteStopped: z.array(z.string()).optional(),
	/** hosted devices warden cloud had already stopped, and why */
	remoteStopReasons: z.record(z.string(), z.enum(["user", "idle", "credits_exhausted", "error"])).optional(),
	/** host-device lease ids released on their warden host */
	hostReleased: z.array(z.string()).optional(),
	deleted: z.array(z.string()),
	quarantined: z.array(z.string()),
	/** ids / udids that matched no lease (exit 1) */
	unknown: z.array(z.string()),
	notes: z.array(z.string()),
});

export type ReleaseJson = z.infer<typeof releaseSchema>;
