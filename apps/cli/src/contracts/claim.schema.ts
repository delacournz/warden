import { z } from "zod";
import { claimedLeaseSchema, versionOf } from "./common.schema";

/** `warden claim --json`. */
export const claimSchema = z.strictObject({
	schemaVersion: versionOf("warden.claim"),
	leases: z.array(claimedLeaseSchema),
	udids: z.array(z.string()),
	/** stale lease ids the claim reclaimed on its way */
	reclaimed: z.array(z.string()),
});

export type ClaimJson = z.infer<typeof claimSchema>;
export type ClaimedLeaseJson = z.infer<typeof claimedLeaseSchema>;
