import { type Exec, execErrors } from "@delacour/warden-runtime/exec";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { npmPlatforms } from "../npm/platforms";

export const DEFAULT_RELEASE_REPO = "delacournz/warden";
export const CHECKSUMS_ASSET = "checksums.txt";

export type Release = { tag: string; version: string; assets: string[] };

export class UpdateRelease {
	releaseRepo(env: Record<string, string | undefined>): string {
		return env.WARDEN_RELEASE_REPO || DEFAULT_RELEASE_REPO;
	}

	/** Release asset for this machine: `warden-<darwin|linux>-<arm64|x64>`. */
	assetName(platform: string, arch: string): Result<string> {
		const target = npmPlatforms.releaseTarget(platform, arch);
		return target.success ? resultFactory.ok(`warden-${target.data}`) : target;
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	/** `gh release view --json tagName,assets` → Release. */
	parseReleaseView(stdout: string): Result<Release> {
		let data: unknown;
		try {
			data = JSON.parse(stdout);
		} catch {
			return resultFactory.err("could not parse `gh release view` output");
		}
		if (!this.isRecord(data) || typeof data.tagName !== "string" || !Array.isArray(data.assets)) {
			return resultFactory.err("unexpected `gh release view` output");
		}
		const assets = data.assets.flatMap((a) => (this.isRecord(a) && typeof a.name === "string" ? [a.name] : []));
		return resultFactory.ok({ tag: data.tagName, version: data.tagName.replace(/^v/, ""), assets });
	}

	pickAsset(release: Release, name: string): Result<string> {
		if (!release.assets.includes(name)) return resultFactory.err(`release ${release.tag} has no ${name} asset`);
		if (!release.assets.includes(CHECKSUMS_ASSET))
			return resultFactory.err(`release ${release.tag} has no ${CHECKSUMS_ASSET}`);
		return resultFactory.ok(name);
	}

	/** `sha256sum` output (`<hex>  <name>` or `<hex> *<name>`) → name → hex. */
	parseChecksums(text: string): Map<string, string> {
		const sums = new Map<string, string>();
		for (const line of text.split("\n")) {
			const match = /^([0-9a-fA-F]+)\s+\*?(\S+)\s*$/.exec(line.trim());
			if (match?.[1] && match[2]) sums.set(match[2], match[1].toLowerCase());
		}
		return sums;
	}

	async latestRelease(exec: Exec, repo: string): AsyncResult<Release> {
		const cmd = ["gh", "release", "view", "--repo", repo, "--json", "tagName,assets"];
		const result = await exec(cmd);
		if (result.exitCode !== 0) {
			if (/release not found/i.test(result.stderr)) return resultFactory.err(`no release published on ${repo} yet`);
			return resultFactory.err(`${execErrors.format(cmd, result)} (is gh installed and authenticated for ${repo}?)`);
		}
		return this.parseReleaseView(result.stdout);
	}

	async downloadRelease(exec: Exec, repo: string, release: Release, asset: string, dir: string): AsyncResult<void> {
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
		return result.exitCode === 0 ? resultFactory.ok(undefined) : resultFactory.err(execErrors.format(cmd, result));
	}
}

export const updateRelease = new UpdateRelease();
