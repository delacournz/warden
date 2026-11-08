#!/usr/bin/env bun
/**
 * `bun scripts/ios-runner-blob.ts <repoRoot> <outFile>`: write the iPhone runner's Xcode project sources
 * (`packages/e2e/native/ios-runner` plus the `warden-simd` files it compiles) as the blob `bun build --compile`
 * embeds. `warden` stages it to `$WARDEN_HOME/ios-runner/src/<version>-<hash>/` and builds it with xcodebuild.
 */
import { join } from "node:path";
import { writeRunnerBlob } from "@delacour/warden-core/ios-runner/pack";

const [repoRoot, outFile] = process.argv.slice(2);
if (!repoRoot || !outFile) {
	console.error("usage: ios-runner-blob.ts <repoRoot> <outFile>");
	process.exit(2);
}
const written = writeRunnerBlob(join(repoRoot, "packages", "e2e", "native"), outFile);
if (!written.success) {
	console.error(written.error);
	process.exit(1);
}
console.log(outFile);
