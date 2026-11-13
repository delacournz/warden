import { z } from "zod";
import { versionOf } from "./common.schema";

/** `warden dev --json`: the one line printed once the device, app and Metro are ready (the process keeps running). */
export const devSchema = z.strictObject({
	schemaVersion: versionOf("warden.dev"),
	udid: z.string(),
	port: z.number(),
	metroUrl: z.string(),
	leaseIds: z.array(z.string()),
	/** where the project config came from */
	source: z.enum(["repo", "overlay", "auto"]),
});

export type DevJson = z.infer<typeof devSchema>;
