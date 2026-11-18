import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_VERSION } from "../../version";
import {
	loadPasskeysApk,
	type PasskeysApkFetch,
	passkeysApkAssetName,
	passkeysApkCachePath,
	passkeysApkDownloadUrl,
	WORKSPACE_PASSKEYS_APK,
} from "./passkeys-apk";
import { PASSKEYS_APK } from "./passkeys-apk.generated";

const bytes = new Uint8Array([80, 75, 3, 4, 9, 9]);
const meta = { bytes: bytes.length, apkSha256: createHash("sha256").update(bytes).digest("hex") };

describe("names", () => {
	test("the release asset and the cache file are named by the APK's hash", () => {
		expect(passkeysApkAssetName({ apkSha256: "abcdef0123456789" })).toBe("warden-passkeys-abcdef01.apk");
		expect(passkeysApkCachePath("/h", { apkSha256: "abcdef0123456789" })).toBe(
			"/h/passkeys-apk/warden-passkeys-abcdef01.apk"
		);
	});

	test("the download is the asset of this version's GitHub release", () => {
		expect(passkeysApkDownloadUrl("1.2.3", { apkSha256: "abcdef0123456789" })).toBe(
			"https://github.com/delacournz/warden/releases/download/v1.2.3/warden-passkeys-abcdef01.apk"
		);
	});
});

describe("the checked-in APK", () => {
	test("is the one the generated module declares", () => {
		const apk = readFileSync(WORKSPACE_PASSKEYS_APK);
		expect(apk.length).toBe(PASSKEYS_APK.bytes);
		expect(createHash("sha256").update(apk).digest("hex")).toBe(PASSKEYS_APK.apkSha256);
	});
});

describe("loadPasskeysApk", () => {
	let home: string;
	let fetched: string[];
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "warden-passkeys-"));
		fetched = [];
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	const serving =
		(body: Uint8Array, status = 200): PasskeysApkFetch =>
		async (url) => {
			fetched.push(url);
			return new Response(body, { status });
		};
	const deps = (over: Partial<Parameters<typeof loadPasskeysApk>[1]> = {}): Parameters<typeof loadPasskeysApk>[1] => ({
		env: {},
		home,
		version: "1.2.3",
		workspaceApk: join(home, "missing.apk"),
		fetch: serving(bytes),
		...over,
	});

	test("downloads on first use, checks the hash and caches it; the second call does not fetch", async () => {
		const first = await loadPasskeysApk(meta, deps());
		expect(first.success && first.data.source).toBe("download");
		expect(fetched).toEqual([passkeysApkDownloadUrl("1.2.3", meta)]);
		expect(existsSync(passkeysApkCachePath(home, meta))).toBe(true);

		const second = await loadPasskeysApk(meta, deps());
		expect(second.success && second.data.source).toBe("cache");
		expect(second.success && [...second.data.bytes]).toEqual([...bytes]);
		expect(fetched).toHaveLength(1);
	});

	test("refuses a download whose hash does not match and caches nothing", async () => {
		const res = await loadPasskeysApk(meta, deps({ fetch: serving(new Uint8Array([1, 2, 3, 4, 5, 6])) }));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("sha256");
		expect(existsSync(passkeysApkCachePath(home, meta))).toBe(false);
	});

	test("an HTTP error names the URL and the offline way out", async () => {
		const res = await loadPasskeysApk(meta, deps({ fetch: serving(new Uint8Array(), 404) }));
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error).toContain("404");
			expect(res.error).toContain(passkeysApkDownloadUrl("1.2.3", meta));
			expect(res.error).toContain("WARDEN_PASSKEYS_APK");
		}
	});

	test("a corrupt cache file is replaced by a fresh download", async () => {
		mkdirSync(join(home, "passkeys-apk"), { recursive: true });
		writeFileSync(passkeysApkCachePath(home, meta), "junk");
		const res = await loadPasskeysApk(meta, deps());
		expect(res.success && res.data.source).toBe("download");
	});

	test("WARDEN_PASSKEYS_APK wins and never touches the network; a wrong file is an error", async () => {
		const file = join(home, "mine.apk");
		writeFileSync(file, bytes);
		const res = await loadPasskeysApk(meta, deps({ env: { WARDEN_PASSKEYS_APK: file } }));
		expect(res.success && res.data.source).toBe("env");
		expect(fetched).toHaveLength(0);

		writeFileSync(file, "nope");
		const bad = await loadPasskeysApk(meta, deps({ env: { WARDEN_PASSKEYS_APK: file } }));
		expect(bad.success).toBe(false);
		if (!bad.success) expect(bad.error).toContain("WARDEN_PASSKEYS_APK");
	});

	test("running from the workspace reads the checked-in APK", async () => {
		const file = join(home, "repo.apk");
		writeFileSync(file, bytes);
		const res = await loadPasskeysApk(meta, deps({ workspaceApk: file, version: WORKSPACE_VERSION }));
		expect(res.success && res.data.source).toBe("workspace");
		expect(fetched).toHaveLength(0);
	});

	test("a workspace build without the APK has no release to download from", async () => {
		const res = await loadPasskeysApk(meta, deps({ version: WORKSPACE_VERSION }));
		expect(res.success).toBe(false);
		expect(fetched).toHaveLength(0);
	});
});
