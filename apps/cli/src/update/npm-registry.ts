import { createHash } from "node:crypto";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { NPM_PACKAGE, platformPackageName, type ReleaseTarget } from "../npm/platforms";
import { extractFile } from "./tar";

/** `fetch`, narrowed to what the registry client uses (injectable for tests). */
export type Fetch = (url: string) => Promise<Response>;

export const DEFAULT_NPM_REGISTRY = "https://registry.npmjs.org";

/** A platform package version's tarball on the registry. */
export type NpmDist = { name: string; tarball: string; integrity: string };

export function npmRegistry(env: Record<string, string | undefined>): string {
	return (env.WARDEN_NPM_REGISTRY || DEFAULT_NPM_REGISTRY).replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function getJson(fetch: Fetch, url: string, missing: string): AsyncResult<Record<string, unknown>> {
	try {
		const response = await fetch(url);
		if (response.status === 404) return err(missing);
		if (!response.ok) return err(`GET ${url} → HTTP ${response.status}`);
		const body: unknown = await response.json();
		return isRecord(body) ? ok(body) : err(`unexpected response from ${url}`);
	} catch (error) {
		return err(`GET ${url} failed: ${message(error)}`);
	}
}

/** Version behind `@delacour/warden`'s `latest` dist-tag. */
export async function latestNpmVersion(fetch: Fetch, registry: string): AsyncResult<string> {
	const url = `${registry}/${NPM_PACKAGE}/latest`;
	const body = await getJson(fetch, url, `${NPM_PACKAGE} is not published on ${registry}`);
	if (!body.success) return body;
	return typeof body.data.version === "string" ? ok(body.data.version) : err(`no version in ${url}`);
}

/** Tarball URL + integrity of `@delacour/warden-<target>@<version>`. */
export async function platformDist(
	fetch: Fetch,
	registry: string,
	target: ReleaseTarget,
	version: string
): AsyncResult<NpmDist> {
	const name = platformPackageName(target);
	const url = `${registry}/${name}/${version}`;
	const body = await getJson(fetch, url, `${name}@${version} is not published on ${registry}`);
	if (!body.success) return body;
	const dist = body.data.dist;
	if (!isRecord(dist) || typeof dist.tarball !== "string" || typeof dist.integrity !== "string") {
		return err(`no dist.tarball / dist.integrity in ${url}`);
	}
	return ok({ name, tarball: dist.tarball, integrity: dist.integrity });
}

/** Does `bytes` match an SRI string? Only `sha512-<base64>` (what npm publishes) is accepted. */
export function verifyIntegrity(bytes: Uint8Array, integrity: string): boolean {
	const expected = integrity
		.split(/\s+/)
		.filter((entry) => entry.startsWith("sha512-"))
		.map((entry) => entry.slice("sha512-".length));
	if (expected.length === 0) return false;
	const actual = createHash("sha512").update(bytes).digest("base64");
	return expected.includes(actual);
}

function extracted(tgz: Uint8Array, dist: NpmDist): Result<Uint8Array> {
	if (!verifyIntegrity(tgz, dist.integrity)) return err(`integrity mismatch for ${dist.name} (${dist.tarball})`);
	return extractFile(tgz, "package/bin/warden");
}

/** Download a platform tarball, verify its sha512 integrity, return `bin/warden`. */
export async function downloadNpmBinary(fetch: Fetch, dist: NpmDist): AsyncResult<Uint8Array> {
	try {
		const response = await fetch(dist.tarball);
		if (!response.ok) return err(`GET ${dist.tarball} → HTTP ${response.status}`);
		return extracted(new Uint8Array(await response.arrayBuffer()), dist);
	} catch (error) {
		return err(`GET ${dist.tarball} failed: ${message(error)}`);
	}
}
