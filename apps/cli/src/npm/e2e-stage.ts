import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { emitDeclarations, entryDeclaration } from "./declarations";
import { bundleE2e, E2E_EXTERNALS } from "./e2e-bundle";
import { E2E_ENTRIES, E2E_TYPES_DIR, e2eManifest, LICENSE_FILE, type PackageMeta } from "./manifests";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The third-party externals of the bundle (`zod`) with the version range `packages/e2e` declares for them. */
export function e2eDependencies(packageJson: string): Result<Record<string, string>> {
	const pkg: unknown = JSON.parse(packageJson);
	const declared = isRecord(pkg) && isRecord(pkg.dependencies) ? pkg.dependencies : {};
	const dependencies: Record<string, string> = {};
	for (const name of E2E_EXTERNALS) {
		if (name.startsWith("bun:")) continue;
		const range = declared[name];
		if (typeof range !== "string")
			return err(`packages/e2e/package.json has no dependency ${name} (the bundle imports it)`);
		dependencies[name] = range;
	}
	return ok(dependencies);
}

/**
 * Stage `@delacour/warden-e2e` into `outDir` from the workspace `packages/e2e`:
 *   package.json, LICENSE
 *   index.mjs, preload.mjs (+ one shared chunk): `Bun.build`, workspace packages inlined, `zod` + `bun:test` external
 *   index.d.ts, preload.d.ts: re-exports of `types/**`, the declarations tsc emits for what the entries reach
 *                             (workspace imports rewritten to relative paths), see `declarations.ts`
 */
export async function stageE2e(input: { repoRoot: string; outDir: string; meta: PackageMeta }): Promise<Result<void>> {
	const { repoRoot, outDir, meta } = input;
	const packages = join(repoRoot, "packages");
	const e2e = join(packages, "e2e");

	const dependencies = e2eDependencies(readFileSync(join(e2e, "package.json"), "utf8"));
	if (!dependencies.success) return dependencies;
	mkdirSync(outDir, { recursive: true });

	const bundled = await bundleE2e({ srcDir: join(e2e, "src"), outDir, version: meta.version });
	if (!bundled.success) return bundled;

	const entries = Object.values(E2E_ENTRIES).map((entry) => ({
		source: entry.js.replace(/\.mjs$/, ".ts"),
		types: entry.types,
	}));
	const typesDir = join(outDir, E2E_TYPES_DIR);
	const emitted = emitDeclarations({
		tsconfigPath: join(e2e, "tsconfig.json"),
		entries: entries.map((entry) => join(e2e, "src", entry.source)),
		packagesDir: packages,
		outDir: typesDir,
	});
	if (!emitted.success) return emitted;
	for (const entry of entries) {
		writeFileSync(join(outDir, entry.types), entryDeclaration(E2E_TYPES_DIR, `e2e/src/${entry.source}`));
	}

	writeFileSync(join(outDir, "package.json"), `${JSON.stringify(e2eManifest(meta, dependencies.data), null, 2)}\n`);
	copyFileSync(join(repoRoot, LICENSE_FILE), join(outDir, LICENSE_FILE));
	return ok(undefined);
}
