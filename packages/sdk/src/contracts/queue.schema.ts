import { z } from "zod";
import { platformSchema } from "./primitives.schema";

export const queueRowSchema = z.object({
	position: z.number(),
	id: z.string(),
	priority: z.string(),
	effectivePriority: z.number(),
	/** points earned by waiting (aging) */
	aged: z.number(),
	ageMs: z.number(),
	platform: platformSchema,
	profile: z.string(),
	units: z.number(),
	owner: z.string(),
	where: z.string().optional(),
	label: z.string().optional(),
	pid: z.number().optional(),
	/** the waiting process is gone; its row is reclaimed by the next claim */
	stale: z.literal(true).optional(),
});
export type QueueRowJson = z.infer<typeof queueRowSchema>;

/** `warden queue --json`. */
export const queueJsonSchema = z.object({ queue: z.array(queueRowSchema) });
export type QueueJson = z.infer<typeof queueJsonSchema>;
