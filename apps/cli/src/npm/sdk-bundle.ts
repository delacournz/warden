import { join } from "node:path";
import { err, ok, type Result } from "@delacour/warden-types/result";
import { SDK_ENTRIES } from "./manifests";

/** Imports the bundle leaves to the consumer: the declared `zod` dependency and the optional `ai` peer. */
export const SDK_EXTERNALS = ["zod", "ai"] as const;

/**
 * Bundle `packages/sdk/src/**` (the entries in `SDK_ENTRIES`) into `<outDir>/**.mjs` for Bun, workspace packages
 * (`@delacour/warden-*`) inlined. `splitting` puts what the entries share in a chunk at the root, so the client
 * a `./ai-sdk` tool drives is the same module instance `.` creates. Entry paths keep their directory
 * (`ai-sdk/tools.mjs`) because `naming.entry` uses `[dir]`.
 */
export async function bundleSdk(input: { srcDir: string; outDir: string }): Promise<Result<string[]>> {
	const result = await Bun.build({
		entrypoints: Object.values(SDK_ENTRIES).map((entry) => join(input.srcDir, entry.source)),
		outdir: input.outDir,
		target: "bun",
		format: "esm",
		splitting: true,
		external: [...SDK_EXTERNALS],
		naming: { entry: "[dir]/[name].mjs", chunk: "chunk-[hash].mjs" },
	});
	if (!result.success) return err(`@delacour/warden-sdk bundle failed:\n${result.logs.join("\n")}`);
	return ok(result.outputs.map((output) => output.path));
}
