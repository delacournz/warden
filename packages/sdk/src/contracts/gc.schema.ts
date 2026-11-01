import { z } from "zod";
import { deviceRefSchema } from "./primitives.schema";

/** `warden gc --json`. */
export const gcJsonSchema = z.object({
	reclaimed: z.array(z.string()),
	shutdown: z.array(deviceRefSchema),
	forgotten: z.array(deviceRefSchema),
	notes: z.array(z.string()),
});
export type GcJson = z.infer<typeof gcJsonSchema>;
