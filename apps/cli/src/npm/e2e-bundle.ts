import { join } from "node:path";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { E2E_ENTRIES } from "./manifests";

/** Imports the bundle leaves to the consumer: bun's own test module and the declared `zod` dependency. */
export const E2E_EXTERNALS = ["bun:test", "zod"] as const;

export class E2eBundle {
	/**
	 * Bundle `packages/e2e/src/{index,preload}.ts` into `<outDir>/{index,preload}.mjs` for Bun, workspace packages
	 * (`@delacour/warden-*`) inlined. `splitting` puts what the two entries share in a chunk, which
	 * matters: the preload registers the default driver on the same `session` module `test` reads, so the entries
	 * must not each carry their own copy. `WARDEN_E2E_VERSION` is defined to the published version.
	 */
	async bundleE2e(input: {
		srcDir: string;
		outDir: string;
		version: string;
		/** imports left to the consumer (default `E2E_EXTERNALS`); the bundled runtime fallback inlines `zod` and keeps only `bun:test` */
		externals?: readonly string[];
	}): Promise<Result<string[]>> {
		const result = await Bun.build({
			entrypoints: Object.values(E2E_ENTRIES).map((entry) => join(input.srcDir, entry.js.replace(/\.mjs$/, ".ts"))),
			outdir: input.outDir,
			target: "bun",
			format: "esm",
			splitting: true,
			external: [...(input.externals ?? E2E_EXTERNALS)],
			naming: { entry: "[name].mjs", chunk: "chunk-[hash].mjs" },
			define: { __WARDEN_E2E_VERSION__: JSON.stringify(input.version) },
		});
		if (!result.success) return resultFactory.err(`@delacour/warden-e2e bundle failed:\n${result.logs.join("\n")}`);
		return resultFactory.ok(result.outputs.map((output) => output.path));
	}
}

export const e2eBundle = new E2eBundle();
