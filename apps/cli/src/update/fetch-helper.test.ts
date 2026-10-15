import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { err, ok } from "@delacour/warden-types/result";
import { fakeHelperDist } from "../npm/helper.testing";
import { packHelper } from "../npm/helper-asset";
import { type ExtractHelper, fetchHelper, helperBaseUrl, helperHomeDir, tarExtractHelper } from "./fetch-helper";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const TGZ = new TextEncoder().encode("pretend tarball");

/** fetch serving `files` by URL; anything else is a 404. Records the URLs asked for. */
function serve(files: Record<string, Uint8Array | string>, asked: string[] = []) {
	return async (url: string): Promise<Response> => {
		asked.push(url);
		const body = files[url];
		return body === undefined ? new Response("nope", { status: 404 }) : new Response(body);
	};
}

function extractor(calls: Array<{ bytes: Uint8Array; dir: string }>): ExtractHelper {
	return async (bytes, dir) => {
		calls.push({ bytes, dir });
		return ok(undefined);
	};
}

const BASE = "https://github.com/delacournz/warden/releases/download/v0.3.0";
const input = (overrides: Partial<Parameters<typeof fetchHelper>[0]>): Parameters<typeof fetchHelper>[0] => ({
	fetch: serve({}),
	extract: extractor([]),
	env: {},
	platform: "darwin",
	arch: "arm64",
	version: "0.3.0",
	wardenHome: "/home/.warden",
	...overrides,
});

describe("helperBaseUrl", () => {
	test("GitHub release by tag v<version>, WARDEN_RELEASE_REPO and WARDEN_HELPER_URL override", () => {
		expect(helperBaseUrl({}, "0.3.0")).toBe(BASE);
		expect(helperBaseUrl({ WARDEN_RELEASE_REPO: "me/fork" }, "0.3.0")).toBe(
			"https://github.com/me/fork/releases/download/v0.3.0"
		);
		expect(helperBaseUrl({ WARDEN_HELPER_URL: "https://mirror.example/h/" }, "0.3.0")).toBe("https://mirror.example/h");
	});
});

describe("fetchHelper", () => {
	test("downloads sums + tarball, verifies, extracts into $WARDEN_HOME/simd/<version>", async () => {
		const asked: string[] = [];
		const calls: Array<{ bytes: Uint8Array; dir: string }> = [];
		const result = await fetchHelper(
			input({
				fetch: serve(
					{
						[`${BASE}/SHA256SUMS`]: `${sha(TGZ)}  warden-simd-darwin-arm64.tgz\n`,
						[`${BASE}/warden-simd-darwin-arm64.tgz`]: TGZ,
					},
					asked
				),
				extract: extractor(calls),
			})
		);
		expect(result).toEqual({
			success: true,
			data: { dir: "/home/.warden/simd/0.3.0", url: `${BASE}/warden-simd-darwin-arm64.tgz`, sha256: sha(TGZ) },
		});
		expect(asked).toEqual([`${BASE}/SHA256SUMS`, `${BASE}/warden-simd-darwin-arm64.tgz`]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.dir).toBe(helperHomeDir("/home/.warden", "0.3.0"));
		expect(calls[0]?.bytes).toEqual(TGZ);
	});

	test("WARDEN_HELPER_URL replaces the release URL", async () => {
		const asked: string[] = [];
		await fetchHelper(input({ env: { WARDEN_HELPER_URL: "http://localhost:9/h" }, fetch: serve({}, asked) }));
		expect(asked).toEqual(["http://localhost:9/h/SHA256SUMS"]);
	});

	test("checksum mismatch: nothing extracted", async () => {
		const calls: Array<{ bytes: Uint8Array; dir: string }> = [];
		const result = await fetchHelper(
			input({
				fetch: serve({
					[`${BASE}/SHA256SUMS`]: `${"0".repeat(64)}  warden-simd-darwin-arm64.tgz\n`,
					[`${BASE}/warden-simd-darwin-arm64.tgz`]: TGZ,
				}),
				extract: extractor(calls),
			})
		);
		expect(result.success).toBe(false);
		if (!result.success) expect(result.error).toContain("checksum mismatch");
		expect(calls).toEqual([]);
	});

	test("SHA256SUMS without the helper entry, 404s and HTTP errors", async () => {
		const noEntry = await fetchHelper(input({ fetch: serve({ [`${BASE}/SHA256SUMS`]: `${sha(TGZ)}  other.tgz\n` }) }));
		expect(noEntry.success).toBe(false);
		if (!noEntry.success) expect(noEntry.error).toContain("no entry for warden-simd-darwin-arm64.tgz");

		const missing = await fetchHelper(input({}));
		expect(missing.success).toBe(false);
		if (!missing.success) expect(missing.error).toContain("not found");

		const down = await fetchHelper(input({ fetch: async () => new Response("", { status: 503 }) }));
		if (down.success) throw new Error("expected failure");
		expect(down.error).toContain("HTTP 503");

		const offline = await fetchHelper(
			input({
				fetch: async () => {
					throw new Error("ENOTFOUND");
				},
			})
		);
		if (offline.success) throw new Error("expected failure");
		expect(offline.error).toContain("ENOTFOUND");
	});

	test("an extract failure is returned", async () => {
		const result = await fetchHelper(
			input({
				fetch: serve({
					[`${BASE}/SHA256SUMS`]: `${sha(TGZ)}  warden-simd-darwin-arm64.tgz\n`,
					[`${BASE}/warden-simd-darwin-arm64.tgz`]: TGZ,
				}),
				extract: async () => err("disk full"),
			})
		);
		expect(result).toEqual({ success: false, error: "disk full" });
	});

	test("no helper for darwin-x64 / linux: nothing fetched", async () => {
		const asked: string[] = [];
		for (const [platform, arch] of [
			["darwin", "x64"],
			["linux", "arm64"],
		] as const) {
			const result = await fetchHelper(input({ platform, arch, fetch: serve({}, asked) }));
			expect(result).toEqual({ success: false, error: `no helper for ${platform}-${arch} in this version` });
		}
		expect(asked).toEqual([]);
	});
});

describe("tarExtractHelper", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "warden-fetch-helper-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("extracts a packHelper tarball, replacing the old dir, leaving no staging dirs", async () => {
		fakeHelperDist(join(root, "dist"));
		const packed = await packHelper({ distDir: join(root, "dist"), outDir: join(root, "out"), exec: bunExec });
		if (!packed.success) throw new Error(packed.error);
		const dest = join(root, "home", "simd", "0.3.0");
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, "stale"), "old");

		const extracted = await tarExtractHelper(bunExec)(readFileSync(packed.data.tgz), dest);
		expect(extracted).toEqual({ success: true, data: undefined });
		expect(existsSync(join(dest, "stale"))).toBe(false);
		expect(existsSync(join(dest, "warden-simd"))).toBe(true);
		expect(existsSync(join(dest, "Resources", "SimulatorFrameworkBridge-iOS"))).toBe(true);
		expect(readdirSync(join(root, "home", "simd"))).toEqual(["0.3.0"]);
	});

	test("garbage or helper-less tarballs are rejected without touching the old dir", async () => {
		const dest = join(root, "simd", "0.3.0");
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, "keep"), "x");
		const garbage = await tarExtractHelper(bunExec)(new TextEncoder().encode("not a tarball"), dest);
		expect(garbage.success).toBe(false);

		mkdirSync(join(root, "empty"));
		writeFileSync(join(root, "empty", "readme"), "hi");
		const emptyTgz = join(root, "empty.tgz");
		await bunExec(["tar", "-czf", emptyTgz, "-C", join(root, "empty"), "."]);
		const noBinary = await tarExtractHelper(bunExec)(readFileSync(emptyTgz), dest);
		expect(noBinary.success).toBe(false);
		if (!noBinary.success) expect(noBinary.error).toContain("no warden-simd");
		expect(existsSync(join(dest, "keep"))).toBe(true);
		expect(readdirSync(join(root, "simd"))).toEqual(["0.3.0"]);
	});
});
