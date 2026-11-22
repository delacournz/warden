import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunExec } from "@delacour/warden-core/exec";
import { err, ok } from "@delacour/warden-types/result";
import { fakeHelperDist } from "../npm/helper.testing";
import { packHelper } from "../npm/helper-asset";
import {
	type ExtractHelper,
	fetchHelper,
	helperBaseUrl,
	helperHomeDir,
	latestHelperBaseUrl,
	sealExtracted,
	tarExtractHelper,
} from "./fetch-helper";
import { makeTgz } from "./tar.testing";

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
const LATEST = "https://github.com/delacournz/warden/releases/latest/download";
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

describe("latestHelperBaseUrl", () => {
	test("the latest GitHub release of WARDEN_RELEASE_REPO", () => {
		expect(latestHelperBaseUrl({})).toBe(LATEST);
		expect(latestHelperBaseUrl({ WARDEN_RELEASE_REPO: "me/fork" })).toBe(
			"https://github.com/me/fork/releases/latest/download"
		);
	});
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
			data: {
				dir: "/home/.warden/simd/0.3.0",
				url: `${BASE}/warden-simd-darwin-arm64.tgz`,
				sha256: sha(TGZ),
				release: "version",
				checksum: "published",
			},
		});
		expect(asked).toEqual([`${BASE}/SHA256SUMS`, `${BASE}/warden-simd-darwin-arm64.tgz`]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.dir).toBe(helperHomeDir("/home/.warden", "0.3.0"));
		expect(calls[0]?.bytes).toEqual(TGZ);
	});

	describe("a build that carries the helper's sha256", () => {
		const TARBALL = `${BASE}/warden-simd-darwin-arm64.tgz`;

		test("checks the tarball against it and never asks for SHA256SUMS", async () => {
			const asked: string[] = [];
			const calls: Array<{ bytes: Uint8Array; dir: string }> = [];
			const result = await fetchHelper(
				input({ pinnedSha256: sha(TGZ), fetch: serve({ [TARBALL]: TGZ }, asked), extract: extractor(calls) })
			);
			expect(result).toEqual({
				success: true,
				data: {
					dir: "/home/.warden/simd/0.3.0",
					url: TARBALL,
					sha256: sha(TGZ),
					release: "version",
					checksum: "embedded",
				},
			});
			expect(asked).toEqual([TARBALL]);
			expect(calls).toHaveLength(1);
		});

		test("a tarball that differs is refused, whatever the release's SHA256SUMS says", async () => {
			const other = new TextEncoder().encode("another tarball");
			const calls: Array<{ bytes: Uint8Array; dir: string }> = [];
			const result = await fetchHelper(
				input({
					pinnedSha256: sha(TGZ),
					fetch: serve({
						[`${BASE}/SHA256SUMS`]: `${sha(other)}  warden-simd-darwin-arm64.tgz\n`,
						[TARBALL]: other,
					}),
					extract: extractor(calls),
				})
			);
			if (result.success) throw new Error("expected failure");
			expect(result.error).toContain("checksum mismatch");
			expect(result.error).toContain("this binary expects");
			expect(calls).toEqual([]);
		});

		test("never takes the latest release's helper", async () => {
			const asked: string[] = [];
			const result = await fetchHelper(
				input({
					pinnedSha256: sha(TGZ),
					fallbackToLatest: true,
					fetch: serve({ [`${LATEST}/warden-simd-darwin-arm64.tgz`]: TGZ }, asked),
				})
			);
			expect(result.success).toBe(false);
			expect(asked).toEqual([TARBALL]);
		});

		test("a WARDEN_HELPER_URL mirror has to serve the same bytes", async () => {
			const mirror = "https://mirror.example/h";
			const env = { WARDEN_HELPER_URL: mirror };
			const good = await fetchHelper(
				input({ pinnedSha256: sha(TGZ), env, fetch: serve({ [`${mirror}/warden-simd-darwin-arm64.tgz`]: TGZ }) })
			);
			expect(good.success).toBe(true);
			const bad = await fetchHelper(
				input({
					pinnedSha256: sha(TGZ),
					env,
					fetch: serve({ [`${mirror}/warden-simd-darwin-arm64.tgz`]: "something else" }),
				})
			);
			expect(bad.success).toBe(false);
		});
	});

	test("WARDEN_HELPER_URL must be https, on this machine, or a file: URL; nothing is fetched otherwise", async () => {
		const asked: string[] = [];
		const result = await fetchHelper(
			input({ env: { WARDEN_HELPER_URL: "http://mirror.example/h" }, fetch: serve({}, asked) })
		);
		if (result.success) throw new Error("expected failure");
		expect(result.error).toContain("WARDEN_HELPER_URL must be an https: URL");
		expect(asked).toEqual([]);
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

	test("fallbackToLatest: a version with no release takes the latest release's helper, staged under this version", async () => {
		const asked: string[] = [];
		const calls: Array<{ bytes: Uint8Array; dir: string }> = [];
		const result = await fetchHelper(
			input({
				fallbackToLatest: true,
				fetch: serve(
					{
						[`${LATEST}/SHA256SUMS`]: `${sha(TGZ)}  warden-simd-darwin-arm64.tgz\n`,
						[`${LATEST}/warden-simd-darwin-arm64.tgz`]: TGZ,
					},
					asked
				),
				extract: extractor(calls),
			})
		);
		expect(result).toEqual({
			success: true,
			data: {
				dir: "/home/.warden/simd/0.3.0",
				url: `${LATEST}/warden-simd-darwin-arm64.tgz`,
				sha256: sha(TGZ),
				release: "latest",
				checksum: "published",
			},
		});
		expect(asked).toEqual([`${BASE}/SHA256SUMS`, `${LATEST}/SHA256SUMS`, `${LATEST}/warden-simd-darwin-arm64.tgz`]);
		expect(calls[0]?.dir).toBe("/home/.warden/simd/0.3.0");
	});

	test("fallbackToLatest only on a 404: never past an HTTP error, never away from WARDEN_HELPER_URL", async () => {
		const asked: string[] = [];
		const down = await fetchHelper(
			input({
				fallbackToLatest: true,
				fetch: async (url) => {
					asked.push(url);
					return new Response("", { status: 503 });
				},
			})
		);
		expect(down.success).toBe(false);
		expect(asked).toEqual([`${BASE}/SHA256SUMS`]);

		const mirrored: string[] = [];
		const mirror = await fetchHelper(
			input({ fallbackToLatest: true, env: { WARDEN_HELPER_URL: "http://localhost:9/h" }, fetch: serve({}, mirrored) })
		);
		expect(mirror.success).toBe(false);
		expect(mirrored).toEqual(["http://localhost:9/h/SHA256SUMS"]);
	});

	test("no release for the version and none latest: the error names both", async () => {
		const result = await fetchHelper(input({ fallbackToLatest: true }));
		if (result.success) throw new Error("expected failure");
		expect(result.error).toContain(`${BASE}/SHA256SUMS not found`);
		expect(result.error).toContain(`${LATEST}/SHA256SUMS not found`);
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

	test("extracted files are 0755 when executable and 0644 otherwise, directories 0755", async () => {
		fakeHelperDist(join(root, "dist"));
		chmodSync(join(root, "dist", "warden-simd"), 0o4777);
		chmodSync(join(root, "dist", "manifest.json"), 0o666);
		chmodSync(join(root, "dist", "Resources"), 0o777);
		const packed = await packHelper({ distDir: join(root, "dist"), outDir: join(root, "out"), exec: bunExec });
		if (!packed.success) throw new Error(packed.error);
		const dest = join(root, "home", "simd", "0.3.0");
		const extracted = await tarExtractHelper(bunExec)(readFileSync(packed.data.tgz), dest);
		expect(extracted).toEqual({ success: true, data: undefined });
		const mode = (path: string) => statSync(join(dest, path)).mode & 0o7777;
		expect(mode("warden-simd")).toBe(0o755);
		expect(mode("manifest.json")).toBe(0o644);
		expect(mode("Resources")).toBe(0o755);
		expect(mode("Resources/SimulatorFrameworkBridge-iOS")).toBe(0o644);
	});

	test("a tarball holding a symlink or a hard link is refused before anything is unpacked", async () => {
		const dest = join(root, "simd", "0.3.0");
		mkdirSync(dest, { recursive: true });
		writeFileSync(join(dest, "keep"), "x");
		const ran: string[][] = [];
		const exec: typeof bunExec = (cmd, opts) => {
			ran.push([...cmd]);
			return bunExec(cmd, opts);
		};
		for (const plant of [
			(dist: string) => symlinkSync("/etc", join(dist, "Resources", "etc")),
			(dist: string) => linkSync(join(dist, "warden-simd"), join(dist, "warden-simd-2")),
		]) {
			const dist = mkdtempSync(join(root, "dist-"));
			fakeHelperDist(dist);
			plant(dist);
			const tgz = join(dist, "..", "planted.tgz");
			await bunExec(["tar", "-czf", tgz, "-C", dist, "."]);
			const result = await tarExtractHelper(exec)(readFileSync(tgz), dest);
			if (result.success) throw new Error("expected failure");
			expect(result.error).toContain("only regular files and directories");
		}
		expect(ran).toEqual([]);
		expect(existsSync(join(dest, "keep"))).toBe(true);
		expect(readdirSync(join(root, "simd"))).toEqual(["0.3.0"]);
	});

	test("an entry that names a path outside the archive is refused", async () => {
		const dest = join(root, "simd", "0.3.0");
		for (const name of ["../escaped", "/tmp/escaped", "Resources/../../escaped"]) {
			const tgz = makeTgz([
				{ name: "warden-simd", content: "bin" },
				{ name, content: "x" },
			]);
			const result = await tarExtractHelper(bunExec)(tgz, dest);
			if (result.success) throw new Error("expected failure");
			expect(result.error).toContain(name);
		}
		expect(existsSync(dest)).toBe(false);
	});
});

describe("sealExtracted", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "warden-seal-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("a symlink, a hard link or a special file anywhere in the tree is an error naming it", async () => {
		mkdirSync(join(root, "link", "sub"), { recursive: true });
		symlinkSync("/etc/hosts", join(root, "link", "sub", "hosts"));
		expect(sealExtracted(join(root, "link"))).toEqual({
			success: false,
			error: "sub/hosts is a symbolic link: the helper holds only regular files and directories",
		});

		mkdirSync(join(root, "hard"));
		writeFileSync(join(root, "hard", "a"), "x");
		linkSync(join(root, "hard", "a"), join(root, "hard", "b"));
		const hard = sealExtracted(join(root, "hard"));
		if (hard.success) throw new Error("expected failure");
		expect(hard.error).toContain("is a hard link");

		mkdirSync(join(root, "fifo"));
		await bunExec(["mkfifo", join(root, "fifo", "pipe")]);
		const fifo = sealExtracted(join(root, "fifo"));
		if (fifo.success) throw new Error("expected failure");
		expect(fifo.error).toContain("pipe is not a regular file");
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
