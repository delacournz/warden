import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const manifest = z.object({
	dependencies: z.record(z.string(), z.string()).optional(),
	devDependencies: z.record(z.string(), z.string()).optional(),
});

/**
 * Which of `names` the app's `package.json` lists in neither `dependencies` nor `devDependencies`.
 * Empty when there is no readable `package.json` (nothing to judge by).
 */
export function missingPackages(root: string, names: readonly string[]): string[] {
	try {
		const parsed = manifest.safeParse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
		if (!parsed.success) return [];
		const listed = { ...parsed.data.dependencies, ...parsed.data.devDependencies };
		return names.filter((name) => !(name in listed));
	} catch {
		return [];
	}
}
