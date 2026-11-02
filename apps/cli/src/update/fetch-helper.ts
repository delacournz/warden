import { join } from "node:path";
import type { Exec } from "@delacour/warden-core/exec";
import { type AsyncResult, err } from "@delacour/warden-types/result";
import { HELPER_ASSET, HELPER_BINARY, HELPER_TARGET } from "../npm/helper";
import { type ExtractAsset, type FetchedAsset, fetchReleaseAsset, releaseBaseUrl, tarExtract } from "./fetch-asset";
import type { Fetch } from "./npm-registry";

/** Unpack the helper tarball into `destDir` (created or replaced). Injected so the download logic stays pure. */
export type ExtractHelper = ExtractAsset;

export type FetchHelperInput = {
	fetch: Fetch;
	extract: ExtractHelper;
	env: Readonly<Record<string, string | undefined>>;
	platform: string;
	arch: string;
	/** warden's version: selects release tag `v<version>` and `$WARDEN_HOME/simd/<version>/` */
	version: string;
	wardenHome: string;
};

export type FetchedHelper = FetchedAsset;

/** `$WARDEN_HOME/simd/<version>`: the last place `locateHelper` looks. */
export function helperHomeDir(wardenHome: string, version: string): string {
	return join(wardenHome, "simd", version);
}

/**
 * Directory URL (no trailing slash) holding `warden-simd-darwin-arm64.tgz` and `SHA256SUMS`: the GitHub release
 * for tag `v<version>`, or `WARDEN_HELPER_URL` (a mirror, or a `file`-served dir for tests).
 */
export function helperBaseUrl(env: Readonly<Record<string, string | undefined>>, version: string): string {
	return releaseBaseUrl(env, "WARDEN_HELPER_URL", version);
}

/**
 * Download the helper tarball for this warden version, verify it against `SHA256SUMS`, and extract it into
 * `$WARDEN_HOME/simd/<version>/`. Nothing is extracted unless the checksum matches.
 */
export async function fetchHelper(input: FetchHelperInput): AsyncResult<FetchedHelper> {
	const { env, platform, arch, version } = input;
	if (`${platform}-${arch}` !== HELPER_TARGET) return err(`no helper for ${platform}-${arch} in this version`);
	return fetchReleaseAsset({
		fetch: input.fetch,
		extract: input.extract,
		base: helperBaseUrl(env, version),
		asset: HELPER_ASSET,
		dir: helperHomeDir(input.wardenHome, version),
	});
}

/** `tar -xzf` the helper tarball, checking `warden-simd` is in it (see `tarExtract`). */
export function tarExtractHelper(exec: Exec): ExtractHelper {
	return tarExtract(exec, HELPER_ASSET, HELPER_BINARY);
}
