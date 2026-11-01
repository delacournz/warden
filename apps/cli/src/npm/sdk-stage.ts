import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { declarationsHelpers } from "./declarations";
import { LICENSE_FILE, npmManifests, type PackageMeta, SDK_ENTRIES, SDK_TYPES_DIR } from "./manifests";
import { SDK_EXTERNALS, sdkBundle } from "./sdk-bundle";

export class SdkStage {
	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	/**
	 * The dependency ranges `packages/sdk` declares for the bundle's externals: `zod` becomes a dependency, `ai` the
	 * optional peer range. Either missing is an error (the bundle would import something the published package does not declare).
	 */
	sdkDependencies(packageJson: string): Result<{ dependencies: Record<string, string>; aiRange: string }> {
		const pkg: unknown = JSON.parse(packageJson);
		const declared = this.isRecord(pkg) && this.isRecord(pkg.dependencies) ? pkg.dependencies : {};
		const peers = this.isRecord(pkg) && this.isRecord(pkg.peerDependencies) ? pkg.peerDependencies : {};
		const dependencies: Record<string, string> = {};
		let aiRange: string | undefined;
		for (const name of SDK_EXTERNALS) {
			if (name === "ai") {
				const range = peers.ai;
				if (typeof range === "string") aiRange = range;
				continue;
			}
			const range = declared[name];
			if (typeof range !== "string")
				return resultFactory.err(`packages/sdk/package.json has no dependency ${name} (the bundle imports it)`);
			dependencies[name] = range;
		}
		if (aiRange === undefined)
			return resultFactory.err("packages/sdk/package.json has no peerDependencies.ai (./ai-sdk imports it)");
		return resultFactory.ok({ dependencies, aiRange });
	}

	/** `export * from "../types/sdk/src/ai-sdk/tools"` for the entry declaration at `types`, relative to the package root. */
	private reexport(types: string, source: string): string {
		const depth = dirname(types) === "." ? 0 : dirname(types).split("/").length;
		const prefix = depth === 0 ? "." : Array.from({ length: depth }, () => "..").join("/");
		return declarationsHelpers
			.entryDeclaration(SDK_TYPES_DIR, `sdk/src/${source}`)
			.replace('"./', `"${prefix}/`)
			.replace('";', '.js";');
	}

	/**
	 * Stage `@delacour/warden-sdk` into `outDir` from the workspace `packages/sdk`:
	 *   package.json, LICENSE
	 *   index.mjs, ai-sdk/tools.mjs, ai-sdk/tools.schema.mjs, plugins/entry.mjs, contracts/index.mjs (+ shared chunks):
	 *     `Bun.build`, workspace packages inlined, `zod` + `ai` external
	 *   the matching `.d.ts` files: re-exports of `types/**`, the declarations tsc emits for what the entries reach
	 *     (workspace imports rewritten to relative paths), see `declarations.ts`
	 */
	async stageSdk(input: { repoRoot: string; outDir: string; meta: PackageMeta }): Promise<Result<void>> {
		const { repoRoot, outDir, meta } = input;
		const packages = join(repoRoot, "packages");
		const sdk = join(packages, "sdk");

		const declared = this.sdkDependencies(readFileSync(join(sdk, "package.json"), "utf8"));
		if (!declared.success) return declared;
		mkdirSync(outDir, { recursive: true });

		const bundled = await sdkBundle.bundleSdk({ srcDir: join(sdk, "src"), outDir });
		if (!bundled.success) return bundled;

		const entries = Object.values(SDK_ENTRIES);
		const emitted = declarationsHelpers.emitDeclarations({
			tsconfigPath: join(sdk, "tsconfig.json"),
			entries: entries.map((entry) => join(sdk, "src", entry.source)),
			packagesDir: packages,
			outDir: join(outDir, SDK_TYPES_DIR),
			esmExtensions: true,
		});
		if (!emitted.success) return emitted;
		for (const entry of entries) {
			const file = join(outDir, entry.types);
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, this.reexport(relative(outDir, file), entry.source.replace(/\.ts$/, "")));
		}

		writeFileSync(
			join(outDir, "package.json"),
			`${JSON.stringify(npmManifests.sdkManifest(meta, declared.data.dependencies, declared.data.aiRange), null, 2)}\n`
		);
		copyFileSync(join(repoRoot, LICENSE_FILE), join(outDir, LICENSE_FILE));
		return resultFactory.ok(undefined);
	}
}

export const sdkStage = new SdkStage();
