import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Exec, execError } from "@delacour/warden-core/exec";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import type { Fetch } from "./npm-registry";
import { parseChecksums, releaseRepo } from "./release";

/** GitHub release asset holding every tarball's sha256 (`<hex>  <name>`). */
export const SUMS_ASSET = "SHA256SUMS";

/** Unpack a release tarball into `destDir` (created or replaced). Injected so the download logic stays pure. */
export type ExtractAsset = (tgz: Uint8Array, destDir: string) => AsyncResult<void>;

export type FetchedAsset = { dir: string; url: string; sha256: string };

/**
 * Directory URL (no trailing slash) holding a release's assets and `SHA256SUMS`: the GitHub release for tag
 * `v<version>`, or the `overrideKey` env var (a mirror, or a `file`-served dir for tests).
 */
export function releaseBaseUrl(
	env: Readonly<Record<string, string | undefined>>,
	overrideKey: string,
	version: string
): string {
	const override = env[overrideKey];
	if (override) return override.replace(/\/+$/, "");
	return `https://github.com/${releaseRepo(env)}/releases/download/v${version}`;
}

async function get(fetch: Fetch, url: string, asset: string): AsyncResult<Uint8Array> {
	try {
		const response = await fetch(url);
		if (response.status === 404) return err(`${url} not found (does the release include ${asset}?)`);
		if (!response.ok) return err(`GET ${url} → HTTP ${response.status}`);
		return ok(new Uint8Array(await response.arrayBuffer()));
	} catch (error) {
		return err(`GET ${url} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export type FetchAssetInput = {
	fetch: Fetch;
	extract: ExtractAsset;
	/** see `releaseBaseUrl` */
	base: string;
	/** tarball name, a key of `SHA256SUMS` */
	asset: string;
	/** where the tarball is extracted to */
	dir: string;
};

/** Download `asset`, verify it against `SHA256SUMS`, and extract it into `dir`. Nothing is extracted unless the checksum matches. */
export async function fetchReleaseAsset(input: FetchAssetInput): AsyncResult<FetchedAsset> {
	const { base, asset } = input;
	const sumsBody = await get(input.fetch, `${base}/${SUMS_ASSET}`, SUMS_ASSET);
	if (!sumsBody.success) return sumsBody;
	const expected = parseChecksums(new TextDecoder().decode(sumsBody.data)).get(asset);
	if (!expected) return err(`${base}/${SUMS_ASSET} has no entry for ${asset}`);

	const url = `${base}/${asset}`;
	const tgz = await get(input.fetch, url, asset);
	if (!tgz.success) return tgz;
	const actual = createHash("sha256").update(tgz.data).digest("hex");
	if (actual !== expected) return err(`checksum mismatch for ${url}: expected ${expected}, got ${actual}`);

	const extracted = await input.extract(tgz.data, input.dir);
	if (!extracted.success) return extracted;
	return ok({ dir: input.dir, url, sha256: actual });
}

/**
 * `tar -xzf` into a sibling temp dir, check `required` (a path inside the archive) is there, then swap it in for
 * `destDir`, so a failed or partial extract never leaves a half install behind.
 */
export function tarExtract(exec: Exec, asset: string, required: string): ExtractAsset {
	return async (tgz, destDir): Promise<Result<void>> => {
		mkdirSync(dirname(destDir), { recursive: true });
		const staging = mkdtempSync(join(dirname(destDir), ".extract-"));
		try {
			const archive = join(staging, "asset.tgz");
			const files = join(staging, "files");
			mkdirSync(files);
			writeFileSync(archive, tgz);
			const cmd = ["tar", "-xzf", archive, "-C", files];
			const result = await exec(cmd);
			if (result.exitCode !== 0) return err(execError(cmd, result));
			if (!existsSync(join(files, required))) return err(`${asset} has no ${required}`);
			rmSync(destDir, { recursive: true, force: true });
			renameSync(files, destDir);
			return ok(undefined);
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	};
}
