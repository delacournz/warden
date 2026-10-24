#!/usr/bin/env bun
/**
 * `bun scripts/e2e-runtime.ts <repoRoot> <outFile> <version>`: bundle `packages/e2e` into the blob that
 * `bun build --compile` embeds (the `@delacour/warden-e2e` fallback for repos that don't depend on it).
 * A process of its own for the same reason as `e2e-bundle-main.ts`: `Bun.build` mis-resolves workspace files
 * that the calling process has already loaded.
 */
import { join } from "node:path";
import { writeRuntimeBlob } from "../src/npm/e2e-runtime-pack";

const [repoRoot, outFile, version] = process.argv.slice(2);
if (!repoRoot || !outFile || !version) {
	console.error("usage: e2e-runtime.ts <repoRoot> <outFile> <version>");
	process.exit(2);
}
const written = await writeRuntimeBlob({ srcDir: join(repoRoot, "packages", "e2e", "src"), version, outFile });
if (!written.success) {
	console.error(written.error);
	process.exit(1);
}
console.log(outFile);
