import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** Lockfile → how to run Expo's installer in that checkout; the first match walking up from the app wins. */
const LOCKFILE_RUNNERS: ReadonlyArray<[lockfile: string, runner: readonly string[]]> = [
	["bun.lock", ["bunx"]],
	["bun.lockb", ["bunx"]],
	["pnpm-lock.yaml", ["pnpm"]],
	["yarn.lock", ["yarn"]],
	["package-lock.json", ["npx"]],
];

/**
 * `expo install <packages>` through the package manager the checkout uses (its lockfile, from `root`
 * upwards), so the install lands in the right lockfile; `bunx expo install` when no lockfile is found.
 */
export function expoInstallCommand(root: string, packages: readonly string[]): string[] {
	for (let dir = root; ; dir = dirname(dir)) {
		const hit = LOCKFILE_RUNNERS.find(([lockfile]) => existsSync(join(dir, lockfile)));
		if (hit) return [...hit[1], "expo", "install", ...packages];
		if (dirname(dir) === dir) return ["bunx", "expo", "install", ...packages];
	}
}
