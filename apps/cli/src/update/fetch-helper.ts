import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { type Exec, execError } from "@delacour/warden-core/exec";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { HELPER_ASSET, HELPER_BINARY, HELPER_SUMS_ASSET, HELPER_TARGET } from "../npm/helper";
import { checkDownloadUrl } from "./download-url";
import type { Fetch } from "./npm-registry";
import { parseChecksums, releaseRepo } from "./release";
import { checkPlainTarball } from "./tar";

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
	 * The sha256 of this version's helper tarball, compiled into a release binary (`BuildInfo.helperSha256`). When
	 * set it is the only checksum the download is held to: `SHA256SUMS` is not fetched and `fallbackToLatest` is off.
	 * Absent in a build from a checkout, which checks against the release's published `SHA256SUMS` instead.
	 */
	pinnedSha256?: string;
	/**
	 * When release `v<version>` does not exist (404), take the latest release's helper instead. For builds from a
	 * checkout, whose version can be ahead of every release (a version-bump branch). Never with `WARDEN_HELPER_URL`,
	 * never with `pinnedSha256`.
	 */
	fallbackToLatest?: boolean;
};

/**
 * `release`: `version` is the release `v<version>`, `latest` the latest release, because `v<version>` has none.
 * `checksum`: `embedded` when the tarball matched the sha256 this binary carries, `published` when it matched the
 * `SHA256SUMS` served next to it.
 */
export type FetchedHelper = {
	dir: string;
	url: string;
	sha256: string;
	release: "version" | "latest";
	checksum: "embedded" | "published";
};

/** `$WARDEN_HOME/simd/<version>`: the last place `locateHelper` looks. */
export function helperHomeDir(wardenHome: string, version: string): string {
	return join(wardenHome, "simd", version);
}

/**
 * Directory URL (no trailing slash) holding `warden-simd-darwin-arm64.tgz` and `SHA256SUMS`: the GitHub release
 * for tag `v<version>`, or `WARDEN_HELPER_URL` (a mirror, or a `file`-served dir for tests; `fetchHelper` holds it
 * to `checkDownloadUrl`).
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

type Expected = {
	base: string;
	sha256: string;
	release: FetchedHelper["release"];
	checksum: FetchedHelper["checksum"];
};

/** Where the tarball is and the sha256 it must have: the one this binary carries, else the release's `SHA256SUMS`. */
async function expectedHelper(input: FetchHelperInput): AsyncResult<Expected> {
	if (input.pinnedSha256 !== undefined) {
		const base = helperBaseUrl(input.env, input.version);
		return ok({ base, sha256: input.pinnedSha256, release: "version", checksum: "embedded" });
	}
	const sums = await getSums(input);
	if (!sums.success) return sums;
	const { base, release } = sums.data;
	const sha256 = parseChecksums(new TextDecoder().decode(sums.data.body)).get(HELPER_ASSET);
	if (!sha256) return err(`${base}/${HELPER_SUMS_ASSET} has no entry for ${HELPER_ASSET}`);
	return ok({ base, sha256, release, checksum: "published" });
}

/**
 * Download the helper tarball for this warden version and extract it into `$WARDEN_HOME/simd/<version>/`. A release
 * binary holds it to the sha256 it was built with (`pinnedSha256`); a build from a checkout holds it to the
 * release's `SHA256SUMS` (or the latest release's, see `fallbackToLatest`). Nothing is extracted unless the
 * checksum matches.
 */
export async function fetchHelper(input: FetchHelperInput): AsyncResult<FetchedHelper> {
	const { platform, arch, version } = input;
	if (`${platform}-${arch}` !== HELPER_TARGET) return err(`no helper for ${platform}-${arch} in this version`);
	if (input.env.WARDEN_HELPER_URL) {
		const checked = checkDownloadUrl(input.env.WARDEN_HELPER_URL, "WARDEN_HELPER_URL");
		if (!checked.success) return checked;
	}

	const expected = await expectedHelper(input);
	if (!expected.success) return expected;
	const { base, sha256, release, checksum } = expected.data;

	const url = `${base}/${HELPER_ASSET}`;
	const tgz = await get(input.fetch, url);
	if (tgz.kind !== "ok") return err(tgz.error);
	const actual = createHash("sha256").update(tgz.data).digest("hex");
	if (actual !== sha256) {
		const who = checksum === "embedded" ? "this binary expects" : `${HELPER_SUMS_ASSET} lists`;
		return err(`checksum mismatch for ${url}: ${who} ${sha256}, got ${actual}`);
	}

	const dir = helperHomeDir(input.wardenHome, version);
	const extracted = await input.extract(tgz.data, dir);
	if (!extracted.success) return extracted;
	return ok({ dir, url, sha256: actual, release, checksum });
}

const PLAIN = "the helper holds only regular files and directories";

/**
 * Walk an extracted helper tree: anything that is not a regular file or a directory (a symlink, a device, a FIFO)
 * and any file with a second hard link is an error. Directories and executables become `0755`, other files `0644`,
 * whatever modes the archive carried.
 */
export function sealExtracted(root: string): Result<void> {
	const seal = (path: string): Result<void> => {
		const shown = relative(root, path);
		const stat = lstatSync(path);
		if (stat.isSymbolicLink()) return err(`${shown} is a symbolic link: ${PLAIN}`);
		if (stat.isDirectory()) {
			chmodSync(path, 0o755);
			return walk(path);
		}
		if (!stat.isFile()) return err(`${shown} is not a regular file: ${PLAIN}`);
		if (stat.nlink > 1) return err(`${shown} is a hard link: ${PLAIN}`);
		chmodSync(path, (stat.mode & 0o111) !== 0 ? 0o755 : 0o644);
		return ok(undefined);
	};
	const walk = (dir: string): Result<void> => {
		for (const name of readdirSync(dir).sort()) {
			const sealed = seal(join(dir, name));
			if (!sealed.success) return sealed;
		}
		return ok(undefined);
	};
	return walk(root);
}

/**
 * `tar -xzf` into a sibling temp dir, check `warden-simd` is there, then swap it in for `destDir`, so a failed
 * or partial extract never leaves a half helper behind. The archive is read first (`checkPlainTarball`: `tar` only
 * runs on one holding plain files and directories under its own root), and the extracted tree is walked again
 * (`sealExtracted`) before it is moved into place.
 */
export function tarExtractHelper(exec: Exec): ExtractHelper {
	return async (tgz, destDir): Promise<Result<void>> => {
		const plain = checkPlainTarball(tgz);
		if (!plain.success) return err(`${HELPER_ASSET}: ${plain.error}`);
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
			const sealed = sealExtracted(files);
			if (!sealed.success) return err(`${HELPER_ASSET}: ${sealed.error}`);
			chmodSync(files, 0o755);
			rmSync(destDir, { recursive: true, force: true });
			renameSync(files, destDir);
			return ok(undefined);
		} finally {
			rmSync(staging, { recursive: true, force: true });
		}
	};
}
