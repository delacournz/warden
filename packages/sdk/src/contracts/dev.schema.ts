import { z } from "zod";

/** `warden dev --json`: one line once Metro is ready. */
export const devJsonSchema = z.object({
	udid: z.string(),
	port: z.number(),
	metroUrl: z.string(),
	leaseIds: z.array(z.string()),
	source: z.enum(["repo", "overlay", "auto"]),
});
export type DevJson = z.infer<typeof devJsonSchema>;

/** `warden app fingerprint --json`. */
export const appFingerprintJsonSchema = z.object({
	project: z.string(),
	projectKey: z.string(),
	root: z.string(),
	variant: z.string().optional(),
	fingerprints: z.partialRecord(z.enum(["ios", "android"]), z.string()),
	native: z.partialRecord(z.enum(["ios", "android"]), z.string()).optional(),
});
export type AppFingerprintJson = z.infer<typeof appFingerprintJsonSchema>;

/** `warden app ensure --json`. */
export const appEnsureJsonSchema = z.object({
	appPath: z.string(),
	hash: z.string(),
	source: z.enum(["installed", "cache", "eas", "build"]),
	installed: z.boolean(),
	/** with `--kind`: the build kind used and asked for, and the simulator repack facts */
	kind: z.enum(["dev", "simulator", "release"]).optional(),
	requestedKind: z.enum(["dev", "simulator", "release"]).optional(),
	jsKey: z.string().optional(),
	baseHash: z.string().optional(),
	reused: z.boolean().optional(),
	bundleMs: z.number().optional(),
	fallbackReason: z.string().optional(),
});
export type AppEnsureJson = z.infer<typeof appEnsureJsonSchema>;
