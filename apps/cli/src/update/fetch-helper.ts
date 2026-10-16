import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Exec, execError } from "@delacour/warden-core/exec";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { HELPER_ASSET, HELPER_BINARY, HELPER_SUMS_ASSET, HELPER_TARGET } from "../npm/helper";
import type { Fetch } from "./npm-registry";
import { parseChecksums, releaseRepo } from "./release";

/** Unpack the helper tarball into `destDir` (created or replaced). Injected so the download logic stays pure. */
export type ExtractHelper = (tgz: Uint8Array, destDir: string) => AsyncResult<void>;

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

export type FetchedHelper = { dir: string; url: string; sha256: string };

/** `$WARDEN_HOME/simd/<version>`: the last place `locateHelper` looks. */
export function helperHomeDir(wardenHome: string, version: string): string {
	return join(wardenHome, "simd", version);
}

/**
 * Directory URL (no trailing slash) holding `warden-simd-darwin-arm64.tgz` and `SHA256SUMS`: the GitHub release
 * for tag `v<version>`, or `WARDEN_HELPER_URL` (a mirror, or a `file`-served dir for tests).
 */
export function helperBaseUrl(env: Readonly<Record<string, string | undefined>>, version: string): string {
	const override = env.WARDEN_HELPER_URL;
	if (override) return override.replace(/\/+$/, "");
	return `https://github.com/${releaseRepo(env)}/releases/download/v${version}`;
}

async function get(fetch: Fetch, url: string): AsyncResult<Uint8Array> {
	try {
		const response = await fetch(url);
		if (response.status === 404) return err(`${url} not found (does the release include ${HELPER_ASSET}?)`);
		if (!response.ok) return err(`GET ${url} → HTTP ${response.status}`);
		return ok(new Uint8Array(await response.arrayBuffer()));
	} catch (error) {
		return err(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Download the helper tarball for this warden version, verify it against `SHA256SUMS`, and extract it into
 * `$WARDEN_HOME/simd/<version>/`. Nothing is extracted unless the checksum matches.
 */
export async function fetchHelper(input: FetchHelperInput): AsyncResult<FetchedHelper> {
	const { env, platform, arch, version } = input;
	if (`${platform}-${arch}` !== HELPER_TARGET) return err(`no helper for ${platform}-${arch} in this version`);
	const base = helperBaseUrl(env, version);

	const sumsBody = await get(input.fetch, `${base}/${HELPER_SUMS_ASSET}`);
	if (!sumsBody.success) return sumsBody;
	const expected = parseChecksums(new TextDecoder().decode(sumsBody.data)).get(HELPER_ASSET);
	if (!expected) return err(`${base}/${HELPER_SUMS_ASSET} has no entry for ${HELPER_ASSET}`);

	const url = `${base}/${HELPER_ASSET}`;
	const tgz = await get(input.fetch, url);
	if (!tgz.success) return tgz;
	const actual = createHash("sha256").update(tgz.data).digest("hex");
	if (actual !== expected) return err(`checksum mismatch for ${url}: expected ${expected}, got ${actual}`);

	const dir = helperHomeDir(input.wardenHome, version);
	const extracted = await input.extract(tgz.data, dir);
	if (!extracted.success) return extracted;
	return ok({ dir, url, sha256: actual });
}

/**
 * `tar -xzf` into a sibling temp dir, check `warden-simd` is there, then swap it in for `destDir`, so a failed
 * or partial extract never leaves a half helper behind.
 */
export function tarExtractHelper(exec: Exec): ExtractHelper {
	return async (tgz, destDir): Promise<Result<void>> => {
		mkdirSync(dirname(destDir), { recursive: true });
		const staging = mkdtempSync(join(dirname(destDir), ".helper-"));
		try {
			const archive = join(staging, "helper.tgz");
			const files = join(staging, "files");
			mkdirSync(files);
			writeFileSync(archive, tgz);
			const cmd = ["tar", "-xzf", archive, "-C", files];
			const result = await exec(cmd);
			if (result.exitCode !== 0) return err(execError(cmd, result));
			if (!existsSync(join(files, HELPER_BINARY))) return err(`${HELPER_ASSET} has no ${HELPER_BINARY}`);
			rmSync(destDir, { recursive: true, force: true });
			renameSync(files, destDir);
			return ok(undefined);
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	};
}
