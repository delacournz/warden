#!/usr/bin/env bun
/**
 * Release assets for `warden doctor --fetch-helper` (run after `native:build`):
 *   dist/warden-simd-darwin-arm64.tgz   tarball of packages/driver-ios/native/dist
 *   dist/SHA256SUMS                     its sha256
 * `WARDEN_E2E_NATIVE_DIST` overrides the helper dist dir.
 */
import { join, resolve } from "node:path";
import { processExec } from "@delacour/warden-runtime/exec";
import { helperAsset } from "../src/npm/helper-asset";

const cliRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(cliRoot, "..", "..");
const distDir = process.env.WARDEN_E2E_NATIVE_DIST || join(repoRoot, "packages", "driver-ios", "native", "dist");

const packed = await helperAsset.packHelper({ distDir, outDir: join(cliRoot, "dist"), exec: processExec.run });
if (!packed.success) throw new Error(packed.error);
console.log(`packed ${packed.data.tgz} (sha256 ${packed.data.sha256})`);
