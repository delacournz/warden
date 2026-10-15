import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "@delacour/warden-core/exec";
import {
	buildFromSource,
	cachePath,
	ensureTarball,
	type IdbLock,
	installLibraries,
	parseLock,
	sha256OfFile,
} from "./deps";

const ok = (stdout = ""): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "warden-deps-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** A tiny tarball with the layout idb's release ships (Package.swift + Resources/SimulatorFrameworkBridge-iOS). */
async function fakeTarball(files: Record<string, string>): Promise<{ path: string; sha256: string }> {
	const src = join(root, "tar-src");
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(join(src, name, ".."), { recursive: true });
		writeFileSync(join(src, name), body);
	}
	const path = join(root, "libs.tar.gz");
	const proc = Bun.spawn(["tar", "-czf", path, "-C", src, "."], { stdout: "ignore", stderr: "pipe" });
	expect(await proc.exited).toBe(0);
	return { path, sha256: await sha256OfFile(path) };
}

const goodLayout = { "Package.swift": "// pkg", "Resources/SimulatorFrameworkBridge-iOS": "guest" };

describe("parseLock", () => {
	test("accepts the lock shape", () => {
		const lock = parseLock(`{"version":"v1.7.2","tarball":"a.tar.gz","sha256":"${"a".repeat(64)}"}`);
		expect(lock.version).toBe("v1.7.2");
	});

	test("rejects a short sha256 and a non-tag version", () => {
		expect(() => parseLock('{"version":"v1.7.2","tarball":"a","sha256":"abc"}')).toThrow();
		expect(() => parseLock(`{"version":"main","tarball":"a","sha256":"${"a".repeat(64)}"}`)).toThrow();
	});

	test("the checked-in lock parses", () => {
		const text = readFileSync(join(import.meta.dir, "..", "idb.lock.json"), "utf8");
		expect(parseLock(text).tarball).toBe("idb-libraries.macos-arm64.tar.gz");
	});
});

describe("cachePath", () => {
	test("keys the tarball by sha256 under ~/Library/Caches/warden-idb", () => {
		expect(cachePath("/Users/x", "ab".repeat(32))).toBe(`/Users/x/Library/Caches/warden-idb/${"ab".repeat(32)}.tar.gz`);
	});
});

describe("ensureTarball", () => {
	test("downloads, verifies and caches on a miss", async () => {
		const tar = await fakeTarball(goodLayout);
		const lock: IdbLock = { version: "v9.9.9", tarball: "libs.tar.gz", sha256: tar.sha256 };
		const urls: string[] = [];
		const fetchImpl = (async (url: string | URL | Request) => {
			urls.push(String(url));
			return new Response(Bun.file(tar.path));
		}) as typeof fetch;
		const lines: string[] = [];
		const result = await ensureTarball(lock, { home: root, fetchImpl, log: (l) => lines.push(l) });
		expect(result.source).toBe("download");
		expect(result.path).toBe(cachePath(root, tar.sha256));
		expect(urls).toEqual(["https://github.com/facebook/idb/releases/download/v9.9.9/libs.tar.gz"]);
		expect(lines.join("\n")).toContain("downloaded");
	});

	test("hits the cache without touching the network", async () => {
		const tar = await fakeTarball(goodLayout);
		const lock: IdbLock = { version: "v9.9.9", tarball: "libs.tar.gz", sha256: tar.sha256 };
		const cached = cachePath(root, tar.sha256);
		mkdirSync(join(cached, ".."), { recursive: true });
		await Bun.write(cached, Bun.file(tar.path));
		const fetchImpl = (async () => {
			throw new Error("network used");
		}) as unknown as typeof fetch;
		const result = await ensureTarball(lock, { home: root, fetchImpl, log: () => {} });
		expect(result.source).toBe("cache");
	});

	test("refuses a download whose sha256 differs and leaves no cache entry", async () => {
		const tar = await fakeTarball(goodLayout);
		const wrong = createHash("sha256").update("other").digest("hex");
		const lock: IdbLock = { version: "v9.9.9", tarball: "libs.tar.gz", sha256: wrong };
		const fetchImpl = (async () => new Response(Bun.file(tar.path))) as unknown as typeof fetch;
		await expect(ensureTarball(lock, { home: root, fetchImpl, log: () => {} })).rejects.toThrow(/sha256 mismatch/);
		expect(existsSync(cachePath(root, wrong))).toBe(false);
	});

	test("replaces a corrupt cache entry", async () => {
		const tar = await fakeTarball(goodLayout);
		const lock: IdbLock = { version: "v9.9.9", tarball: "libs.tar.gz", sha256: tar.sha256 };
		const cached = cachePath(root, tar.sha256);
		mkdirSync(join(cached, ".."), { recursive: true });
		writeFileSync(cached, "corrupt");
		const fetchImpl = (async () => new Response(Bun.file(tar.path))) as unknown as typeof fetch;
		const result = await ensureTarball(lock, { home: root, fetchImpl, log: () => {} });
		expect(result.source).toBe("download");
		expect(await sha256OfFile(cached)).toBe(tar.sha256);
	});
});

describe("installLibraries", () => {
	test("extracts, stamps, and is idempotent", async () => {
		const tar = await fakeTarball(goodLayout);
		const lock: IdbLock = { version: "v9.9.9", tarball: "libs.tar.gz", sha256: tar.sha256 };
		const dest = join(root, "idb-libraries");
		expect(await installLibraries(lock, tar.path, dest)).toBe("installed");
		expect(readFileSync(join(dest, "Package.swift"), "utf8")).toBe("// pkg");
		expect(existsSync(join(dest, "Resources", "SimulatorFrameworkBridge-iOS"))).toBe(true);
		expect(await installLibraries(lock, tar.path, dest)).toBe("up-to-date");
	});

	test("re-extracts when the stamp names a source build", async () => {
		const tar = await fakeTarball(goodLayout);
		const lock: IdbLock = { version: "v9.9.9", tarball: "libs.tar.gz", sha256: tar.sha256 };
		const dest = join(root, "idb-libraries");
		await installLibraries(lock, tar.path, dest);
		writeFileSync(join(dest, ".warden-idb.json"), JSON.stringify({ version: "v9.9.9", source: "source" }));
		expect(await installLibraries(lock, tar.path, dest)).toBe("installed");
	});

	test("rejects a tarball without the guest binary and keeps the previous install", async () => {
		const good = await fakeTarball(goodLayout);
		const dest = join(root, "idb-libraries");
		await installLibraries({ version: "v1.0.0", tarball: "x", sha256: good.sha256 }, good.path, dest);
		rmSync(join(root, "tar-src"), { recursive: true, force: true });
		const bad = await fakeTarball({ "Package.swift": "// pkg" });
		await expect(
			installLibraries({ version: "v1.0.1", tarball: "x", sha256: bad.sha256 }, bad.path, dest)
		).rejects.toThrow(/SimulatorFrameworkBridge-iOS/);
		expect(readFileSync(join(dest, "Package.swift"), "utf8")).toBe("// pkg");
		expect(existsSync(join(dest, "Resources", "SimulatorFrameworkBridge-iOS"))).toBe(true);
	});
});

describe("buildFromSource", () => {
	const lock: IdbLock = { version: "v1.7.2", tarball: "t", sha256: "a".repeat(64) };

	function fakeExec(describeOutput: string): { exec: Exec; calls: string[] } {
		const calls: string[] = [];
		const exec: Exec = async (cmd) => {
			calls.push(cmd.join(" "));
			if (cmd.includes("describe")) return ok(describeOutput);
			return ok();
		};
		return { exec, calls };
	}

	test("inits the shallow submodule, checks the tag, builds libraries then the package", async () => {
		const idbDir = join(root, "idb");
		mkdirSync(join(idbDir, "Build", "LibraryPackage", "Resources"), { recursive: true });
		writeFileSync(join(idbDir, "Build", "LibraryPackage", "Package.swift"), "// pkg");
		writeFileSync(join(idbDir, "Build", "LibraryPackage", "Resources", "SimulatorFrameworkBridge-iOS"), "guest");
		const { exec, calls } = fakeExec("v1.7.2\n");
		const dest = join(root, "idb-libraries");
		await buildFromSource(lock, { exec, repoRoot: root, idbDir, dest, log: () => {} });
		expect(calls[0]).toContain("submodule update --init --depth 1");
		expect(calls.some((c) => c.includes("describe --tags --exact-match"))).toBe(true);
		const buildLibs = calls.findIndex((c) => c.endsWith("build.sh build libraries"));
		const buildPkg = calls.findIndex((c) => c.endsWith("build.sh build library-package"));
		expect(buildLibs).toBeGreaterThan(-1);
		expect(buildPkg).toBeGreaterThan(buildLibs);
		expect(readFileSync(join(dest, "Package.swift"), "utf8")).toBe("// pkg");
		expect(JSON.parse(readFileSync(join(dest, ".warden-idb.json"), "utf8")).source).toBe("source");
	});

	test("fails when the submodule is on a different tag than the lock", async () => {
		const { exec } = fakeExec("v1.6.0\n");
		const idbDir = join(root, "idb");
		mkdirSync(idbDir, { recursive: true });
		await expect(
			buildFromSource(lock, { exec, repoRoot: root, idbDir, dest: join(root, "d"), log: () => {} })
		).rejects.toThrow(/v1\.6\.0.*v1\.7\.2/);
	});
});
