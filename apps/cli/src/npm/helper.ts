import { err, ok, type Result } from "@delacour/warden-types/result";
import type { ReleaseTarget } from "./platforms";

/** The only target that ships `warden-simd` (idb's libraries are arm64-only). */
export const HELPER_TARGET: ReleaseTarget = "darwin-arm64";
/** The helper executable, in the e2e native `dist/` and next to `warden` in the platform package. */
export const HELPER_BINARY = "warden-simd";
/** Holds `SimulatorFrameworkBridge-iOS`, the in-sim AX guest the helper spawns. */
export const HELPER_RESOURCES = "Resources";
/** The guest the helper cannot work without. */
export const HELPER_GUEST = `${HELPER_RESOURCES}/SimulatorFrameworkBridge-iOS`;
/** `{ version, idb, xcode, builtAt }` written by `native:build`. */
export const HELPER_MANIFEST = "manifest.json";
/** The injected network/clock dylib for simulator apps, built by `native:build` next to the helper. */
export const HELPER_INJECT = "libwarden-inject.dylib";
/** GitHub release asset: a tarball of the native `dist/`, extracted into `$WARDEN_HOME/simd/<version>/`. */
export const HELPER_ASSET = `${HELPER_BINARY}-${HELPER_TARGET}.tgz`;
/** GitHub release asset holding the tarball's sha256 (`<hex>  <name>`). */
export const HELPER_SUMS_ASSET = "SHA256SUMS";

/** What `doctor` shows about the helper build; recorded in the platform package.json `warden.helper`. */
export type HelperInfo = { version: string; idb: string; xcode: string };

/** The helper as staged: its build info and the stub framework directory names (`X.framework`). */
export type StagedHelper = HelperInfo & { frameworks: string[]; inject: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `manifest.json` → `{ version, idb, xcode }`. `builtAt` is dropped so package manifests stay reproducible. */
export function parseHelperManifest(text: string): Result<HelperInfo> {
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return err("helper manifest.json is not valid JSON");
	}
	if (!isRecord(data)) return err("helper manifest.json is not an object");
	const { version, idb, xcode } = data;
	if (typeof version !== "string" || typeof idb !== "string" || typeof xcode !== "string") {
		return err("helper manifest.json needs string version, idb and xcode");
	}
	return ok({ version, idb, xcode });
}

/** Paths (relative to the platform package root) the helper adds to its `files`. */
export function helperFiles(binDir: string, frameworks: readonly string[], inject = false): string[] {
	return [
		`${binDir}/${HELPER_BINARY}`,
		`${binDir}/${HELPER_RESOURCES}`,
		`${binDir}/${HELPER_MANIFEST}`,
		...frameworks.map((framework) => `${binDir}/${framework}`),
		...(inject ? [`${binDir}/${HELPER_INJECT}`] : []),
	];
}
