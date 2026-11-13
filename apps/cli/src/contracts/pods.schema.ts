import { z } from "zod";
import { versionOf } from "./common.schema";

const base = { schemaVersion: versionOf("warden.pods.install"), ms: z.number() };
const keyed = { ...base, key: z.string(), mode: z.enum(["cng", "committed"]) };

/** `warden pods install --json`: what the install did (`outcome`), and the cache key it is filed under when it had one. */
export const podsInstallSchema = z.union([
	z.strictObject({ ...keyed, outcome: z.enum(["hit", "up-to-date"]) }),
	z.strictObject({ ...keyed, outcome: z.literal("miss"), stored: z.boolean(), storeError: z.string().optional() }),
	z.strictObject({ ...base, outcome: z.literal("uncached"), reason: z.string() }),
]);

export type PodsInstallJson = z.infer<typeof podsInstallSchema>;
