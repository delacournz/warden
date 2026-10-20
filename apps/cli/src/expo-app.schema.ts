import { z } from "zod";

/** The slice of an app's `package.json` that `missingPackages` reads. */
export const manifestSchema = z.object({
	dependencies: z.record(z.string(), z.string()).optional(),
	devDependencies: z.record(z.string(), z.string()).optional(),
});
