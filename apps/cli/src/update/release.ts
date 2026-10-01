import type { Exec } from "@delacour/warden-core/exec";
import { execError } from "@delacour/warden-core/exec";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { releaseTarget } from "../npm/platforms";

export const DEFAULT_RELEASE_REPO = "delacournz/warden";
export const CHECKSUMS_ASSET = "checksums.txt";

export type Release = { tag: string; version: string; assets: string[] };

export function releaseRepo(env: Record<string, string | undefined>): string {
	return env.WARDEN_RELEASE_REPO || DEFAULT_RELEASE_REPO;
}

/** Release asset for this machine: `warden-<darwin|linux>-<arm64|x64>`. */
export function assetName(platform: string, arch: string): Result<string> {
	const target = releaseTarget(platform, arch);
	return target.success ? ok(`warden-${target.data}`) : target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `gh release view --json tagName,assets` → Release. */
export function parseReleaseView(stdout: string): Result<Release> {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return err("could not parse `gh release view` output");
	}
	if (!isRecord(data) || typeof data.tagName !== "string" || !Array.isArray(data.assets)) {
		return err("unexpected `gh release view` output");
	}
	const assets = data.assets.flatMap((a) => (isRecord(a) && typeof a.name === "string" ? [a.name] : []));
	return ok({ tag: data.tagName, version: data.tagName.replace(/^v/, ""), assets });
}

export function pickAsset(release: Release, name: string): Result<string> {
	if (!release.assets.includes(name)) return err(`release ${release.tag} has no ${name} asset`);
	if (!release.assets.includes(CHECKSUMS_ASSET)) return err(`release ${release.tag} has no ${CHECKSUMS_ASSET}`);
	return ok(name);
}

/** `sha256sum` output (`<hex>  <name>` or `<hex> *<name>`) → name → hex. */
export function parseChecksums(text: string): Map<string, string> {
	const sums = new Map<string, string>();
	for (const line of text.split("\n")) {
		const match = /^([0-9a-fA-F]+)\s+\*?(\S+)\s*$/.exec(line.trim());
		if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
	}
	return sums;
}

export async function latestRelease(exec: Exec, repo: string): AsyncResult<Release> {
	const cmd = ["gh", "release", "view", "--repo", repo, "--json", "tagName,assets"];
	const result = await exec(cmd);
	if (result.exitCode !== 0) {
		if (/release not found/i.test(result.stderr)) return err(`no release published on ${repo} yet`);
		return err(`${execError(cmd, result)} (is gh installed and authenticated for ${repo}?)`);
	}
	return parseReleaseView(result.stdout);
}

export async function downloadRelease(
	exec: Exec,
	repo: string,
	release: Release,
	asset: string,
	dir: string
): AsyncResult<void> {
	const cmd = [
		"gh",
		"release",
		"download",
		release.tag,
		"--repo",
		repo,
		"--pattern",
		asset,
		"--pattern",
		CHECKSUMS_ASSET,
		"--dir",
		dir,
		"--clobber",
	];
	const result = await exec(cmd);
	return result.exitCode === 0 ? ok(undefined) : err(execError(cmd, result));
}
