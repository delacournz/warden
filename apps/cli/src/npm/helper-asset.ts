import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Exec, execError } from "@delacour/warden-core/exec";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { HELPER_ASSET, HELPER_BINARY, HELPER_GUEST, HELPER_MANIFEST, HELPER_SUMS_ASSET } from "./helper";

export type PackedHelper = { tgz: string; sums: string; sha256: string };

/**
 * Tar the built helper dir (`native/dist`) into `<outDir>/warden-simd-darwin-arm64.tgz` and write
 * `<outDir>/SHA256SUMS` (`<hex>  <asset>`). The tarball root is the dist dir itself (no top-level folder), so
 * extracting it into `$WARDEN_HOME/simd/<version>/` yields `warden-simd`, `Resources/`, `*.framework`, `manifest.json`.
 */
export async function packHelper(input: { distDir: string; outDir: string; exec: Exec }): AsyncResult<PackedHelper> {
	const { distDir, outDir, exec } = input;
	for (const name of [HELPER_BINARY, HELPER_GUEST, HELPER_MANIFEST]) {
		if (!existsSync(join(distDir, name))) return err(`${distDir} has no ${name} — run native:build first`);
	}
	mkdirSync(outDir, { recursive: true });
	const tgz = join(outDir, HELPER_ASSET);
	// COPYFILE_DISABLE: no `._*` AppleDouble entries for extended attributes.
	const cmd = ["tar", "-czf", tgz, "-C", distDir, "."];
	const result = await exec(cmd, { env: { COPYFILE_DISABLE: "1" } });
	if (result.exitCode !== 0) return err(execError(cmd, result));
	const sha256 = createHash("sha256").update(readFileSync(tgz)).digest("hex");
	const sums = join(outDir, HELPER_SUMS_ASSET);
	writeFileSync(sums, `${sha256}  ${HELPER_ASSET}\n`);
	return ok({ tgz, sums, sha256 });
}
