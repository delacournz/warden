import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The zod schema (`expo-app.schema.ts`), loaded on the first parse so `warden dev --help` stays off zod.
 * `require`, not `import()`: `missingPackages` is synchronous.
 */
let schemas: typeof import("./expo-app.schema") | undefined;
function expoAppSchemas(): typeof import("./expo-app.schema") {
	schemas ??= require("./expo-app.schema") as typeof import("./expo-app.schema");
	return schemas;
}

/**
 * Which of `names` the app's `package.json` lists in neither `dependencies` nor `devDependencies`.
 * Empty when there is no readable `package.json` (nothing to judge by).
 */
export function missingPackages(root: string, names: readonly string[]): string[] {
	try {
		const parsed = expoAppSchemas().manifestSchema.safeParse(
			JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
		);
		if (!parsed.success) return [];
		const listed = { ...parsed.data.dependencies, ...parsed.data.devDependencies };
		return names.filter((name) => !(name in listed));
	} catch {
		return [];
	}
}
