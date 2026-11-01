import { z } from "zod";
import { platformSchema } from "./primitives.schema";

/** One claimed device, as `warden claim --json` / `warden run --json` list it. */
export const claimedDeviceSchema = z.object({
	leaseId: z.string(),
	platform: platformSchema,
	udid: z.string(),
	name: z.string(),
	action: z.enum(["reuse", "boot", "create"]),
	/** set for a real phone or tablet: how it is connected, and its hardware serial when known */
	physical: z.object({ transport: z.string(), hwSerial: z.string().optional() }).optional(),
	ttlMs: z.number(),
	label: z.string().optional(),
});
export type ClaimedDeviceJson = z.infer<typeof claimedDeviceSchema>;

/** `claimedJson(outcome)`: the leases of a claim. */
export const claimedJsonSchema = z.array(claimedDeviceSchema);

/** `warden claim --json`. */
export const claimJsonSchema = z.object({
	leases: claimedJsonSchema,
	udids: z.array(z.string()),
	reclaimed: z.array(z.string()),
});
export type ClaimJson = z.infer<typeof claimJsonSchema>;

/** `warden run --json`: the first line, printed once the devices (and ports) are leased. */
export const runJsonSchema = z.object({
	leases: claimedJsonSchema,
	ports: z.array(z.object({ leaseId: z.string(), port: z.number() })),
	cmd: z.array(z.string()),
});
export type RunJson = z.infer<typeof runJsonSchema>;
