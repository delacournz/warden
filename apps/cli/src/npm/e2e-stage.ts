import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { declarationsHelpers } from "./declarations";
import { E2E_EXTERNALS, e2eBundle } from "./e2e-bundle";
import { E2E_ENTRIES, E2E_TYPES_DIR, LICENSE_FILE, npmManifests, type PackageMeta } from "./manifests";

export class E2eStage {
	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	/** The third-party externals of the bundle (`zod`) with the version range `packages/e2e` declares for them. */
	e2eDependencies(packageJson: string): Result<Record<string, string>> {
		const pkg: unknown = JSON.parse(packageJson);
		const declared = this.isRecord(pkg) && this.isRecord(pkg.dependencies) ? pkg.dependencies : {};
		const dependencies: Record<string, string> = {};
		for (const name of E2E_EXTERNALS) {
			if (name.startsWith("bun:")) continue;
			const range = declared[name];
			if (typeof range !== "string")
				return resultFactory.err(`packages/e2e/package.json has no dependency ${name} (the bundle imports it)`);
			dependencies[name] = range;
		}
		return resultFactory.ok(dependencies);
	}

	/**
	 * Stage `@delacour/warden-e2e` into `outDir` from the workspace `packages/e2e`:
	 *   package.json, LICENSE
	 *   index.mjs, preload.mjs (+ one shared chunk): `Bun.build`, workspace packages inlined, `zod` + `bun:test` external
	 *   index.d.ts, preload.d.ts: re-exports of `types/**`, the declarations tsc emits for what the entries reach
	 *                             (workspace imports rewritten to relative paths), see `declarations.ts`
	 */
	async stageE2e(input: { repoRoot: string; outDir: string; meta: PackageMeta }): Promise<Result<void>> {
		const { repoRoot, outDir, meta } = input;
		const packages = join(repoRoot, "packages");
		const e2e = join(packages, "e2e");

		const dependencies = this.e2eDependencies(readFileSync(join(e2e, "package.json"), "utf8"));
		if (!dependencies.success) return dependencies;
		mkdirSync(outDir, { recursive: true });

		const bundled = await e2eBundle.bundleE2e({ srcDir: join(e2e, "src"), outDir, version: meta.version });
		if (!bundled.success) return bundled;

		const entries = Object.values(E2E_ENTRIES).map((entry) => ({
			source: entry.js.replace(/\.mjs$/, ".ts"),
			types: entry.types,
		}));
		const typesDir = join(outDir, E2E_TYPES_DIR);
		const emitted = declarationsHelpers.emitDeclarations({
			tsconfigPath: join(e2e, "tsconfig.json"),
			entries: entries.map((entry) => join(e2e, "src", entry.source)),
			packagesDir: packages,
			outDir: typesDir,
		});
		if (!emitted.success) return emitted;
		for (const entry of entries) {
			writeFileSync(
				join(outDir, entry.types),
				declarationsHelpers.entryDeclaration(E2E_TYPES_DIR, `e2e/src/${entry.source}`)
			);
		}

		writeFileSync(
			join(outDir, "package.json"),
			`${JSON.stringify(npmManifests.e2eManifest(meta, dependencies.data), null, 2)}\n`
		);
		copyFileSync(join(repoRoot, LICENSE_FILE), join(outDir, LICENSE_FILE));
		return resultFactory.ok(undefined);
	}
}

export const e2eStage = new E2eStage();
