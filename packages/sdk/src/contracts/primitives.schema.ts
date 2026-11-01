import { z } from "zod";

export const platformSchema = z.enum(["ios", "android"]);

const deviceResourceSchema = z.object({
	kind: z.literal("device"),
	platform: platformSchema,
	id: z.string(),
	name: z.string(),
});
const portResourceSchema = z.object({ kind: z.literal("port"), port: z.number() });
const buildResourceSchema = z.object({ kind: z.literal("build"), key: z.string() });

/** What a lease holds. */
export const resourceSchema = z.discriminatedUnion("kind", [
	deviceResourceSchema,
	portResourceSchema,
	buildResourceSchema,
]);

const agentOwnerSchema = z.object({
	kind: z.literal("agent"),
	sessionId: z.string(),
	cwd: z.string(),
	repo: z.string().optional(),
	worktree: z.string().optional(),
});
const userOwnerSchema = z.object({
	kind: z.literal("user"),
	pid: z.number(),
	tty: z.string().optional(),
	cwd: z.string(),
	repo: z.string().optional(),
	worktree: z.string().optional(),
});
const ciOwnerSchema = z.object({ kind: z.literal("ci"), runId: z.string() });

/** Who holds a lease. */
export const ownerSchema = z.discriminatedUnion("kind", [agentOwnerSchema, userOwnerSchema, ciOwnerSchema]);

/** A lease row of the store. */
export const leaseSchema = z.object({
	id: z.string(),
	resource: resourceSchema,
	owner: ownerSchema,
	label: z.string().optional(),
	acquiredAt: z.number(),
	heartbeatAt: z.number(),
	ttlMs: z.number(),
	pid: z.number().optional(),
	bootedByOwner: z.boolean().optional(),
	heartbeatMs: z.number().optional(),
	provider: z.string().optional(),
	/** held by `warden dev` (or a `shared` SDK claim): the owner's other processes attach instead of `device_busy` */
	shared: z.boolean().optional(),
});

/** A device that was shut down or forgotten, as `gc` reports it. */
export const deviceRefSchema = z.object({ platform: platformSchema, id: z.string(), name: z.string() });
