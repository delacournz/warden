#!/usr/bin/env bun
/**
 * `bun e2e-bundle-main.ts <srcDir> <outDir> <version>`: `bundleE2e` as a process. `build:npm` calls the function
 * directly; the test runs this instead, because `Bun.build` inside `bun test` mis-resolves workspace files that
 * the test process itself has already loaded.
 */
import { bundleE2e } from "./e2e-bundle";

const [srcDir, outDir, version] = process.argv.slice(2);
if (!srcDir || !outDir || !version) {
	console.error("usage: e2e-bundle-main.ts <srcDir> <outDir> <version>");
	process.exit(2);
}
const built = await bundleE2e({ srcDir, outDir, version });
if (!built.success) {
	console.error(built.error);
	process.exit(1);
}
console.log(built.data.join("\n"));
