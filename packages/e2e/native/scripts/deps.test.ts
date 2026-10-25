import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	sourcePath,
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

	test("accepts a hosted url and a fork commit as the source, and rejects a short ref", () => {
		const base = `"version":"v1.7.2","tarball":"a.tar.gz","sha256":"${"a".repeat(64)}"`;
		const lock = parseLock(
			`{${base},"url":"https://example.test/r/a.tar.gz","source":{"repository":"https://example.test/idb.git","ref":"${"b".repeat(40)}"}}`
		);
		expect(lock.url).toBe("https://example.test/r/a.tar.gz");
		expect(lock.source?.ref).toBe("b".repeat(40));
		expect(() =>
			parseLock(`{${base},"source":{"repository":"https://example.test/idb.git","ref":"1768a0d"}}`)
		).toThrow();
		expect(() => parseLock(`{${base},"url":"not a url"}`)).toThrow();
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

	test("downloads from the lock's url when it names one", async () => {
		const tar = await fakeTarball(goodLayout);
		const url = "https://github.com/delacournz/warden/releases/download/idb-v9.9.9-warden.1/libs.tar.gz";
		const lock: IdbLock = { version: "v9.9.9", tarball: "libs.tar.gz", sha256: tar.sha256, url };
		const urls: string[] = [];
		const fetchImpl = (async (u: string | URL | Request) => {
			urls.push(String(u));
			return new Response(Bun.file(tar.path));
		}) as typeof fetch;
		await ensureTarball(lock, { home: root, fetchImpl, log: () => {} });
		expect(urls).toEqual([url]);
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

	test("drops the SwiftPM build dir when the package changes, keeps it when up to date", async () => {
		const tar = await fakeTarball(goodLayout);
		const dest = join(root, "idb-libraries");
		const build = join(root, "ios", ".build");
		await installLibraries({ version: "v1.0.0", tarball: "x", sha256: tar.sha256 }, tar.path, dest);
		mkdirSync(build, { recursive: true });
		writeFileSync(join(build, "marker"), "");
		expect(await installLibraries({ version: "v1.0.0", tarball: "x", sha256: tar.sha256 }, tar.path, dest)).toBe(
			"up-to-date"
		);
		expect(existsSync(join(build, "marker"))).toBe(true);
		await installLibraries({ version: "v1.0.1", tarball: "x", sha256: tar.sha256 }, tar.path, dest);
		expect(existsSync(build)).toBe(false);
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

describe("sourcePath", () => {
	test("keys the idb checkout by tag under ~/Library/Caches/warden-idb/src", () => {
		expect(sourcePath("/Users/x", "v1.7.2")).toBe("/Users/x/Library/Caches/warden-idb/src/v1.7.2");
	});
});

describe("buildFromSource", () => {
	const lock: IdbLock = { version: "v1.7.2", tarball: "t", sha256: "a".repeat(64) };

	/** Lay out what idb's `build.sh build library-package` leaves behind in a checkout. */
	function fakeCheckout(dir: string): void {
		mkdirSync(join(dir, ".git"), { recursive: true });
		mkdirSync(join(dir, "Build", "LibraryPackage", "Resources"), { recursive: true });
		writeFileSync(join(dir, "Build", "LibraryPackage", "Package.swift"), "// pkg");
		writeFileSync(join(dir, "Build", "LibraryPackage", "Resources", "SimulatorFrameworkBridge-iOS"), "guest");
	}

	/** `git clone` lays out a checkout at its last argument; `describe` answers `describeOutput`. */
	function fakeExec(describeOutput: string): { exec: Exec; calls: { cmd: string; cwd?: string }[] } {
		const calls: { cmd: string; cwd?: string }[] = [];
		const exec: Exec = async (cmd, opts) => {
			calls.push({ cmd: cmd.join(" "), cwd: opts?.cwd });
			if (cmd[0] === "git" && cmd[1] === "clone") fakeCheckout(cmd[cmd.length - 1] ?? "");
			if (cmd.includes("describe")) return ok(describeOutput);
			return ok();
		};
		return { exec, calls };
	}

	test("shallow-clones idb at the lock tag, then builds libraries then the package in the checkout", async () => {
		const srcDir = join(root, "src", "v1.7.2");
		const dest = join(root, "idb-libraries");
		const { exec, calls } = fakeExec("v1.7.2\n");
		await buildFromSource(lock, { exec, srcDir, dest, log: () => {} });
		expect(calls[0]?.cmd).toStartWith("git clone --depth 1 --branch v1.7.2 https://github.com/facebook/idb.git ");
		expect(existsSync(join(srcDir, ".git"))).toBe(true);
		expect(calls.some((c) => c.cmd === `git -C ${srcDir} describe --tags --exact-match`)).toBe(true);
		const buildLibs = calls.findIndex((c) => c.cmd === "./build.sh build libraries" && c.cwd === srcDir);
		const buildPkg = calls.findIndex((c) => c.cmd === "./build.sh build library-package" && c.cwd === srcDir);
		expect(buildLibs).toBeGreaterThan(-1);
		expect(buildPkg).toBeGreaterThan(buildLibs);
		expect(readFileSync(join(dest, "Package.swift"), "utf8")).toBe("// pkg");
		expect(JSON.parse(readFileSync(join(dest, ".warden-idb.json"), "utf8")).source).toBe("source");
	});

	test("reuses an existing checkout without cloning", async () => {
		const srcDir = join(root, "idb");
		fakeCheckout(srcDir);
		const { exec, calls } = fakeExec("v1.7.2\n");
		await buildFromSource(lock, { exec, srcDir, dest: join(root, "idb-libraries"), log: () => {} });
		expect(calls.some((c) => c.cmd.startsWith("git clone"))).toBe(false);
	});

	test("leaves no checkout behind when the clone fails", async () => {
		const srcDir = join(root, "src", "v1.7.2");
		const exec: Exec = async (cmd) => {
			if (cmd[1] === "clone") mkdirSync(cmd[cmd.length - 1] ?? "", { recursive: true });
			return { exitCode: 128, stdout: "", stderr: "fatal: Remote branch v1.7.2 not found" };
		};
		await expect(buildFromSource(lock, { exec, srcDir, dest: join(root, "d"), log: () => {} })).rejects.toThrow(
			/Remote branch/
		);
		expect(existsSync(srcDir)).toBe(false);
		expect(readdirSync(join(root, "src"))).toEqual([]);
	});

	test("fails when the checkout is on a different tag than the lock", async () => {
		const srcDir = join(root, "idb");
		fakeCheckout(srcDir);
		const { exec } = fakeExec("v1.6.0\n");
		await expect(buildFromSource(lock, { exec, srcDir, dest: join(root, "d"), log: () => {} })).rejects.toThrow(
			/v1\.6\.0.*v1\.7\.2/
		);
	});

	const ref = "1768a0d1006ff528c2fd78f335d9e3ee2f01596d";
	const forkLock: IdbLock = { ...lock, source: { repository: "https://github.com/UrbanChrisy/idb.git", ref } };

	/** `git init` lays out the checkout; `rev-parse HEAD` answers `head`; `describe` is never asked. */
	function fakeForkExec(head: string): { exec: Exec; calls: { cmd: string; cwd?: string }[] } {
		const calls: { cmd: string; cwd?: string }[] = [];
		const exec: Exec = async (cmd, opts) => {
			calls.push({ cmd: cmd.join(" "), cwd: opts?.cwd });
			if (cmd[0] === "git" && cmd[1] === "init") fakeCheckout(cmd[cmd.length - 1] ?? "");
			if (cmd.includes("rev-parse")) return ok(`${head}\n`);
			if (cmd.includes("describe")) return { exitCode: 128, stdout: "", stderr: "fatal: no tag exactly matches" };
			return ok();
		};
		return { exec, calls };
	}

	test("fetches the fork commit the lock pins by sha into a fresh repository, then builds", async () => {
		const srcDir = join(root, "src", ref);
		const { exec, calls } = fakeForkExec(ref);
		await buildFromSource(forkLock, { exec, srcDir, dest: join(root, "idb-libraries"), log: () => {} });
		const partial = calls[0]?.cmd.split(" ").at(-1) ?? "";
		expect(calls.map((c) => c.cmd).slice(0, 4)).toEqual([
			`git init -q ${partial}`,
			`git -C ${partial} remote add origin https://github.com/UrbanChrisy/idb.git`,
			`git -C ${partial} fetch --depth 1 origin ${ref}`,
			`git -C ${partial} checkout -q --detach FETCH_HEAD`,
		]);
		expect(calls.some((c) => c.cmd.startsWith("git clone"))).toBe(false);
		expect(existsSync(join(srcDir, ".git"))).toBe(true);
		expect(calls.some((c) => c.cmd === "./build.sh build libraries" && c.cwd === srcDir)).toBe(true);
	});

	test("fails when a fork checkout is at another commit than the lock pins", async () => {
		const srcDir = join(root, "idb");
		fakeCheckout(srcDir);
		const { exec } = fakeForkExec("33a400490a1f53f81e070474435bef8ef10b30b4");
		await expect(buildFromSource(forkLock, { exec, srcDir, dest: join(root, "d"), log: () => {} })).rejects.toThrow(
			/33a40049.*1768a0d1/
		);
	});
});
