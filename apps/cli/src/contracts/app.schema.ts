import { z } from "zod";
import { versionOf } from "./common.schema";

const ensureBase = {
	schemaVersion: versionOf("warden.app.ensure"),
	/** the cached `.app` / `.apk` ("" only when already installed and the cache no longer has it) */
	appPath: z.string(),
	hash: z.string(),
	source: z.enum(["installed", "cache", "eas", "build"]),
	/** the app is on the device at `hash` (false when no device was given) */
	installed: z.boolean(),
};

const kindName = z.enum(["dev", "simulator", "release"]);

/** `warden app ensure --json`: without `--kind`, or with the kind that was built and what was asked for. */
export const appEnsureSchema = z.union([
	z.strictObject(ensureBase),
	z.strictObject({
		...ensureBase,
		kind: z.literal("simulator"),
		requestedKind: kindName,
		jsKey: z.string(),
		baseHash: z.string(),
		reused: z.boolean(),
		bundleMs: z.number().optional(),
		fromBase: z.literal(true).optional(),
	}),
	z.strictObject({
		...ensureBase,
		kind: z.enum(["dev", "release"]),
		requestedKind: kindName,
		fallbackReason: z.string().optional(),
	}),
]);

export type AppEnsureJson = z.infer<typeof appEnsureSchema>;
