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
	/**
	 * When release `v<version>` does not exist (404), take the latest release's helper instead. For builds from a
	 * checkout, whose version can be ahead of every release (a version-bump branch). Never with `WARDEN_HELPER_URL`.
	 */
	fallbackToLatest?: boolean;
};

/** `version`: the release `v<version>`; `latest`: the latest release, because `v<version>` has none. */
export type FetchedHelper = { dir: string; url: string; sha256: string; release: "version" | "latest" };

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

/** The latest GitHub release's download directory: where `fallbackToLatest` looks. */
export function latestHelperBaseUrl(env: Readonly<Record<string, string | undefined>>): string {
	return `https://github.com/${releaseRepo(env)}/releases/latest/download`;
}

type Got = { kind: "ok"; data: Uint8Array } | { kind: "not-found"; error: string } | { kind: "failed"; error: string };

async function get(fetch: Fetch, url: string): Promise<Got> {
	try {
		const response = await fetch(url);
		if (response.status === 404) {
			return { kind: "not-found", error: `${url} not found (does the release include ${HELPER_ASSET}?)` };
		}
		if (!response.ok) return { kind: "failed", error: `GET ${url} → HTTP ${response.status}` };
		return { kind: "ok", data: new Uint8Array(await response.arrayBuffer()) };
	} catch (error) {
		return { kind: "failed", error: `GET ${url} failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** `SHA256SUMS` of release `v<version>`, else (on a 404, when allowed) of the latest release. */
async function getSums(
	input: FetchHelperInput
): AsyncResult<{ base: string; body: Uint8Array; release: FetchedHelper["release"] }> {
	const base = helperBaseUrl(input.env, input.version);
	const sums = await get(input.fetch, `${base}/${HELPER_SUMS_ASSET}`);
	if (sums.kind === "ok") return ok({ base, body: sums.data, release: "version" });
	if (sums.kind === "failed" || !input.fallbackToLatest || input.env.WARDEN_HELPER_URL) return err(sums.error);
	const latest = latestHelperBaseUrl(input.env);
	const latestSums = await get(input.fetch, `${latest}/${HELPER_SUMS_ASSET}`);
	if (latestSums.kind === "ok") return ok({ base: latest, body: latestSums.data, release: "latest" });
	return err(`${sums.error}; ${latestSums.error}`);
}

/**
 * Download the helper tarball for this warden version (or the latest release's, see `fallbackToLatest`), verify it
 * against `SHA256SUMS`, and extract it into `$WARDEN_HOME/simd/<version>/`. Nothing is extracted unless the
 * checksum matches.
 */
export async function fetchHelper(input: FetchHelperInput): AsyncResult<FetchedHelper> {
	const { platform, arch, version } = input;
	if (`${platform}-${arch}` !== HELPER_TARGET) return err(`no helper for ${platform}-${arch} in this version`);

	const sums = await getSums(input);
	if (!sums.success) return sums;
	const { base, release } = sums.data;
	const expected = parseChecksums(new TextDecoder().decode(sums.data.body)).get(HELPER_ASSET);
	if (!expected) return err(`${base}/${HELPER_SUMS_ASSET} has no entry for ${HELPER_ASSET}`);

	const url = `${base}/${HELPER_ASSET}`;
	const tgz = await get(input.fetch, url);
	if (tgz.kind !== "ok") return err(tgz.error);
	const actual = createHash("sha256").update(tgz.data).digest("hex");
	if (actual !== expected) return err(`checksum mismatch for ${url}: expected ${expected}, got ${actual}`);

	const dir = helperHomeDir(input.wardenHome, version);
	const extracted = await input.extract(tgz.data, dir);
	if (!extracted.success) return extracted;
	return ok({ dir, url, sha256: actual, release });
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
