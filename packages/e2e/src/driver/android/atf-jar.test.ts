import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_VERSION } from "../../version";
import { ATF_DEX } from "./atf-dex.generated";
import { type AtfFetch, atfAssetName, atfCachePath, atfDownloadUrl, loadAtfJar, WORKSPACE_ATF_JAR } from "./atf-jar";

const bytes = new Uint8Array([80, 75, 3, 4, 9, 9]);
const meta = { bytes: bytes.length, jarSha256: createHash("sha256").update(bytes).digest("hex") };

describe("names", () => {
	test("the release asset and the cache file are named by the jar's hash", () => {
		expect(atfAssetName({ jarSha256: "abcdef0123456789" })).toBe("warden-atf-abcdef01.jar");
		expect(atfCachePath("/h", { jarSha256: "abcdef0123456789" })).toBe("/h/atf/warden-atf-abcdef01.jar");
	});

	test("the download is the asset of this version's GitHub release", () => {
		expect(atfDownloadUrl("1.2.3", { jarSha256: "abcdef0123456789" })).toBe(
			"https://github.com/delacournz/warden/releases/download/v1.2.3/warden-atf-abcdef01.jar"
		);
	});
});

describe("the checked-in jar", () => {
	test("is the one the generated module declares", () => {
		const jar = readFileSync(WORKSPACE_ATF_JAR);
		expect(jar.length).toBe(ATF_DEX.bytes);
		expect(createHash("sha256").update(jar).digest("hex")).toBe(ATF_DEX.jarSha256);
	});
});

describe("loadAtfJar", () => {
	let home: string;
	let fetched: string[];
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "warden-atf-"));
		fetched = [];
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));

	const serving =
		(body: Uint8Array, status = 200): AtfFetch =>
		async (url) => {
			fetched.push(url);
			return new Response(body, { status });
		};
	const deps = (over: Partial<Parameters<typeof loadAtfJar>[1]> = {}): Parameters<typeof loadAtfJar>[1] => ({
		env: {},
		home,
		version: "1.2.3",
		workspaceJar: join(home, "missing.jar"),
		fetch: serving(bytes),
		...over,
	});

	test("downloads on first use, checks the hash and caches it; the second call does not fetch", async () => {
		const first = await loadAtfJar(meta, deps());
		expect(first.success && first.data.source).toBe("download");
		expect(fetched).toEqual([atfDownloadUrl("1.2.3", meta)]);
		expect(existsSync(atfCachePath(home, meta))).toBe(true);

		const second = await loadAtfJar(meta, deps());
		expect(second.success && second.data.source).toBe("cache");
		expect(second.success && [...second.data.bytes]).toEqual([...bytes]);
		expect(fetched).toHaveLength(1);
	});

	test("refuses a download whose hash does not match and caches nothing", async () => {
		const res = await loadAtfJar(meta, deps({ fetch: serving(new Uint8Array([1, 2, 3, 4, 5, 6])) }));
		expect(res.success).toBe(false);
		if (!res.success) expect(res.error).toContain("sha256");
		expect(existsSync(atfCachePath(home, meta))).toBe(false);
	});

	test("an HTTP error names the URL and the offline way out", async () => {
		const res = await loadAtfJar(meta, deps({ fetch: serving(new Uint8Array(), 404) }));
		expect(res.success).toBe(false);
		if (!res.success) {
			expect(res.error).toContain("404");
			expect(res.error).toContain(atfDownloadUrl("1.2.3", meta));
			expect(res.error).toContain("WARDEN_ATF_JAR");
		}
	});

	test("a corrupt cache file is replaced by a fresh download", async () => {
		mkdirSync(join(home, "atf"), { recursive: true });
		writeFileSync(atfCachePath(home, meta), "junk");
		const res = await loadAtfJar(meta, deps());
		expect(res.success && res.data.source).toBe("download");
	});

	test("WARDEN_ATF_JAR wins and never touches the network; a wrong file is an error", async () => {
		const file = join(home, "mine.jar");
		writeFileSync(file, bytes);
		const res = await loadAtfJar(meta, deps({ env: { WARDEN_ATF_JAR: file } }));
		expect(res.success && res.data.source).toBe("env");
		expect(fetched).toHaveLength(0);

		writeFileSync(file, "nope");
		const bad = await loadAtfJar(meta, deps({ env: { WARDEN_ATF_JAR: file } }));
		expect(bad.success).toBe(false);
		if (!bad.success) expect(bad.error).toContain("WARDEN_ATF_JAR");
	});

	test("running from the workspace reads the checked-in jar", async () => {
		const file = join(home, "repo.jar");
		writeFileSync(file, bytes);
		const res = await loadAtfJar(meta, deps({ workspaceJar: file, version: WORKSPACE_VERSION }));
		expect(res.success && res.data.source).toBe("workspace");
		expect(fetched).toHaveLength(0);
	});

	test("a workspace build without the jar has no release to download from", async () => {
		const res = await loadAtfJar(meta, deps({ version: WORKSPACE_VERSION }));
		expect(res.success).toBe(false);
		expect(fetched).toHaveLength(0);
	});
});
