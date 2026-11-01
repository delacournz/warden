import { z } from "zod";

/** Which app shows simulator windows. */
export const simViewerSchema = z.enum(["simulator", "device-hub", "none"]);

/** `warden arrange --json`: the sims tiled (and the viewer), or with `--open` the sims whose windows were asked for. */
export const arrangeJsonSchema = z.union([
	z.object({ arranged: z.array(z.string()), viewer: simViewerSchema }),
	z.object({ opened: z.array(z.string()) }),
]);
export type ArrangeJson = z.infer<typeof arrangeJsonSchema>;
