import { z } from "zod";
import { platformSchema } from "./primitives.schema";

const costSchema = z.object({ memMb: z.number(), cpu: z.number() });

export const platformUsageSchema = z.object({
	booted: z.number(),
	warden: z.number(),
	foreign: z.number(),
	memMb: z.number(),
	units: z.number(),
});

/** `warden capacity --json`. */
export const capacityJsonSchema = z.object({
	enabled: z.boolean(),
	host: z.object({ os: z.string(), totalMemGb: z.number(), perfCores: z.number(), effCores: z.number() }),
	budget: z.object({ memMb: z.number(), cpu: z.number(), maxUnits: z.number().nullable() }),
	config: z.object({
		max: z.number().optional(),
		headroomGb: z.number().optional(),
		cost: z.partialRecord(platformSchema, costSchema.partial()).optional(),
	}),
	cost: z.object({ ios: costSchema, android: costSchema }),
	/** what a slimmed iOS sim costs */
	slimCost: z.object({ ios: costSchema }),
	usage: z.object({
		total: z.object({ memMb: z.number(), units: z.number() }),
		ios: platformUsageSchema,
		android: platformUsageSchema,
	}),
	maxConcurrent: z.object({ ios: z.number(), android: z.number() }),
	pressure: z.enum(["normal", "warn", "critical", "unknown"]),
	explain: z.string(),
});
export type CapacityJson = z.infer<typeof capacityJsonSchema>;
