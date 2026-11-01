import { z } from "zod";
import { leaseSchema, ownerSchema } from "./primitives.schema";

/** `warden ls --json`. */
export const lsJsonSchema = z.object({
	leases: z.array(leaseSchema.extend({ state: z.enum(["alive", "stale"]) })),
});
export type LsJson = z.infer<typeof lsJsonSchema>;

/** `warden check --json`: free, yours, or held by someone else. */
export const checkJsonSchema = z.union([
	z.object({ udid: z.string(), free: z.literal(true), mine: z.literal(false) }),
	z.object({ udid: z.string(), free: z.literal(false), mine: z.literal(true), leaseId: z.string() }),
	z.object({
		udid: z.string(),
		free: z.literal(false),
		mine: z.literal(false),
		leaseId: z.string(),
		owner: ownerSchema,
	}),
]);
export type CheckJson = z.infer<typeof checkJsonSchema>;

/** `warden release --json`. */
export const releaseJsonSchema = z.object({
	released: z.array(z.string()),
	shutdown: z.array(z.string()),
	quarantined: z.array(z.string()),
	unknown: z.array(z.string()),
	notes: z.array(z.string()),
});
export type ReleaseJson = z.infer<typeof releaseJsonSchema>;

/** `warden port claim --json` and `warden port ls --json`: the port leases. */
export const portLeasesJsonSchema = z.array(leaseSchema);
export type PortLeasesJson = z.infer<typeof portLeasesJsonSchema>;

/** `warden port release --json`. */
export const portReleaseJsonSchema = z.object({
	released: z.array(leaseSchema),
	denied: z.array(leaseSchema),
	missing: z.array(z.string()),
});
export type PortReleaseJson = z.infer<typeof portReleaseJsonSchema>;
