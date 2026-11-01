#!/usr/bin/env bun
/**
 * `bun sdk-bundle-main.ts <srcDir> <outDir>`: `bundleSdk` as a process. `build:npm` calls the function directly; the
 * test runs this instead, because `Bun.build` inside `bun test` mis-resolves workspace files that the test process
 * itself has already loaded.
 */
import { sdkBundle } from "./sdk-bundle";

const [srcDir, outDir] = process.argv.slice(2);
if (!srcDir || !outDir) {
	console.error("usage: sdk-bundle-main.ts <srcDir> <outDir>");
	process.exit(2);
}
const built = await sdkBundle.bundleSdk({ srcDir, outDir });
if (!built.success) {
	console.error(built.error);
	process.exit(1);
}
console.log(built.data.join("\n"));
