import { createHash } from "node:crypto";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { NPM_PACKAGE, npmPlatforms, type ReleaseTarget } from "../npm/platforms";
import { tarHelpers } from "./tar";

/** `fetch`, narrowed to what the registry client uses (injectable for tests). */
export type Fetch = (url: string) => Promise<Response>;

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** A platform package version's tarball on the registry. */
export type NpmDist = { name: string; tarball: string; integrity: string };

export class NpmRegistryHelpers {
	npmRegistry(env: Record<string, string | undefined>): string {
		return (env.WARDEN_NPM_REGISTRY || DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
	}

	private isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	private message(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	private async getJson(fetch: Fetch, url: string, missing: string): AsyncResult<Record<string, unknown>> {
		try {
			const response = await fetch(url);
			if (response.status === 404) return resultFactory.err(missing);
			if (!response.ok) return resultFactory.err(`GET ${url} → HTTP ${response.status}`);
			const body: unknown = await response.json();
			return this.isRecord(body) ? resultFactory.ok(body) : resultFactory.err(`unexpected response from ${url}`);
		} catch (error) {
			return resultFactory.err(`GET ${url} failed: ${this.message(error)}`);
		}
	}

	/** Version behind `@delacour/warden`'s `latest` dist-tag. */
	async latestNpmVersion(fetch: Fetch, registry: string): AsyncResult<string> {
		const url = `${registry}/${NPM_PACKAGE}/latest`;
		const body = await this.getJson(fetch, url, `${NPM_PACKAGE} is not published on ${registry}`);
		if (!body.success) return body;
		return typeof body.data.version === "string"
			? resultFactory.ok(body.data.version)
			: resultFactory.err(`no version in ${url}`);
	}

	/** Tarball URL + integrity of `@delacour/warden-<target>@<version>`. */
	async platformDist(fetch: Fetch, registry: string, target: ReleaseTarget, version: string): AsyncResult<NpmDist> {
		const name = npmPlatforms.platformPackageName(target);
		const url = `${registry}/${name}/${version}`;
		const body = await this.getJson(fetch, url, `${name}@${version} is not published on ${registry}`);
		if (!body.success) return body;
		const dist = body.data.dist;
		if (!this.isRecord(dist) || typeof dist.tarball !== "string" || typeof dist.integrity !== "string") {
			return resultFactory.err(`no dist.tarball / dist.integrity in ${url}`);
		}
		return resultFactory.ok({ name, tarball: dist.tarball, integrity: dist.integrity });
	}

	/** Does `bytes` match an SRI string? Only `sha512-<base64>` (what npm publishes) is accepted. */
	verifyIntegrity(bytes: Uint8Array, integrity: string): boolean {
		const expected = integrity
			.split(/\s+/)
			.filter((entry) => entry.startsWith("sha512-"))
			.map((entry) => entry.slice("sha512-".length));
		if (expected.length === 0) return false;
		const actual = createHash("sha512").update(bytes).digest("base64");
		return expected.includes(actual);
	}

	private extracted(tgz: Uint8Array, dist: NpmDist): Result<Uint8Array> {
		if (!this.verifyIntegrity(tgz, dist.integrity))
			return resultFactory.err(`integrity mismatch for ${dist.name} (${dist.tarball})`);
		return tarHelpers.extractFile(tgz, "package/bin/warden");
	}

	/** Download a platform tarball, verify its sha512 integrity, return `bin/warden`. */
	async downloadNpmBinary(fetch: Fetch, dist: NpmDist): AsyncResult<Uint8Array> {
		try {
			const response = await fetch(dist.tarball);
			if (!response.ok) return resultFactory.err(`GET ${dist.tarball} → HTTP ${response.status}`);
			return this.extracted(new Uint8Array(await response.arrayBuffer()), dist);
		} catch (error) {
			return resultFactory.err(`GET ${dist.tarball} failed: ${this.message(error)}`);
		}
	}
}

export const npmRegistryHelpers = new NpmRegistryHelpers();
