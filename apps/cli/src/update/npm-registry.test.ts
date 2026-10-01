import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	DEFAULT_NPM_REGISTRY,
	downloadNpmBinary,
	type Fetch,
	latestNpmVersion,
	npmRegistry,
	platformDist,
	verifyIntegrity,
} from "./npm-registry";
import { makeTgz } from "./tar.testing";

const integrity = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function fakeFetch(routes: Record<string, () => Response>, calls: string[] = []): Fetch {
	return async (url) => {
		calls.push(url);
		const route = routes[url];
		return route ? route() : new Response("not found", { status: 404 });
	};
}

const R = DEFAULT_NPM_REGISTRY;

test("npmRegistry: WARDEN_NPM_REGISTRY overrides, trailing slash dropped", () => {
	expect(npmRegistry({})).toBe("https://registry.npmjs.org");
	expect(npmRegistry({ WARDEN_NPM_REGISTRY: "https://npm.example.com/" })).toBe("https://npm.example.com");
});

describe("latestNpmVersion", () => {
	test("reads the latest dist-tag's version", async () => {
		const calls: string[] = [];
		const fetch = fakeFetch({ [`${R}/@delacour/warden/latest`]: () => Response.json({ version: "0.3.0" }) }, calls);
		expect(await latestNpmVersion(fetch, R)).toEqual({ success: true, data: "0.3.0" });
		expect(calls).toEqual([`${R}/@delacour/warden/latest`]);
	});

	test("404 → not published yet", async () => {
		const result = await latestNpmVersion(fakeFetch({}), R);
		expect(result).toEqual({ success: false, error: `@delacour/warden is not published on ${R}` });
	});

	test("network failure → error", async () => {
		const result = await latestNpmVersion(async () => {
			throw new Error("ECONNREFUSED");
		}, R);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("ECONNREFUSED");
	});

	test("malformed body → error", async () => {
		const fetch = fakeFetch({ [`${R}/@delacour/warden/latest`]: () => Response.json({ nope: 1 }) });
		expect((await latestNpmVersion(fetch, R)).success).toBe(false);
	});
});

describe("platformDist", () => {
	test("tarball + integrity of one platform package version", async () => {
		const fetch = fakeFetch({
			[`${R}/@delacour/warden-darwin-arm64/0.3.0`]: () =>
				Response.json({ version: "0.3.0", dist: { tarball: "https://t/x.tgz", integrity: "sha512-abc" } }),
		});
		expect(await platformDist(fetch, R, "darwin-arm64", "0.3.0")).toEqual({
			success: true,
			data: { name: "@delacour/warden-darwin-arm64", tarball: "https://t/x.tgz", integrity: "sha512-abc" },
		});
	});
});

describe("verifyIntegrity", () => {
	test("sha512 SRI match / mismatch / unsupported algorithm", () => {
		const bytes = new TextEncoder().encode("hello");
		expect(verifyIntegrity(bytes, integrity(bytes))).toBe(true);
		expect(verifyIntegrity(bytes, integrity(new TextEncoder().encode("other")))).toBe(false);
		expect(verifyIntegrity(bytes, `sha1-${createHash("sha1").update(bytes).digest("base64")}`)).toBe(false);
	});
});

describe("downloadNpmBinary", () => {
	const tgz = makeTgz([
		{ name: "package/package.json", content: "{}" },
		{ name: "package/bin/warden", content: "NPM-BINARY" },
	]);
	const dist = { name: "@delacour/warden-darwin-arm64", tarball: "https://t/x.tgz", integrity: integrity(tgz) };

	test("verified tarball → bin/warden bytes", async () => {
		const fetch = fakeFetch({ "https://t/x.tgz": () => new Response(tgz) });
		const result = await downloadNpmBinary(fetch, dist);
		expect(result.success && new TextDecoder().decode(result.data)).toBe("NPM-BINARY");
	});

	test("integrity mismatch → error, nothing extracted", async () => {
		const fetch = fakeFetch({ "https://t/x.tgz": () => new Response(tgz) });
		const result = await downloadNpmBinary(fetch, { ...dist, integrity: integrity(new Uint8Array([1])) });
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("integrity mismatch");
	});
});
