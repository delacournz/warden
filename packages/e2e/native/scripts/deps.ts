#!/usr/bin/env bun
/**
 * `bun native/scripts/deps.ts [--from-source]` — materialise `native/idb-libraries/`, the library package
 * `native/ios/Package.swift` links against.
 *
 * Default: download the pinned release tarball (`idb.lock.json`) into `~/Library/Caches/warden-idb/<sha256>.tar.gz`,
 * verify its sha256, extract. `--from-source`: build the same layout with idb's own `build.sh` from a shallow clone of
 * the pinned tag in `~/Library/Caches/warden-idb/src/<tag>`, or from `WARDEN_IDB_SRC` (a patched checkout).
 * Idempotent: `idb-libraries/.warden-idb.json` records what is installed.
 *
 * No git submodule on purpose: `git worktree remove` refuses any worktree with a populated submodule.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { bunExec, type Exec, execError } from "@delacour/warden-core/exec";
import { z } from "zod";

const lockSchema = z.object({
	version: z.string().regex(/^v\d+\.\d+\.\d+$/, "version must be an idb release tag like v1.7.2"),
	tarball: z.string().min(1),
	sha256: z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars"),
});

export type IdbLock = z.infer<typeof lockSchema>;

const stampSchema = z.object({
	version: z.string(),
	source: z.enum(["release", "source"]),
	sha256: z.string().optional(),
});

type Stamp = z.infer<typeof stampSchema>;

const STAMP_FILE = ".warden-idb.json";
/** Files a usable library package must contain; checked before anything is swapped into place. */
const REQUIRED_FILES = ["Package.swift", join("Resources", "SimulatorFrameworkBridge-iOS")] as const;

export function parseLock(text: string): IdbLock {
	return lockSchema.parse(JSON.parse(text));
}

export function cachePath(home: string, sha256: string): string {
	return join(home, "Library", "Caches", "warden-idb", `${sha256}.tar.gz`);
}

/** Where `--from-source` keeps its shallow idb checkout for `version`, shared by every worktree. */
export function sourcePath(home: string, version: string): string {
	return join(home, "Library", "Caches", "warden-idb", "src", version);
}

export async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

export type TarballDeps = { home: string; fetchImpl: typeof fetch; log: (line: string) => void };

/** The cached tarball for `lock`, downloading and verifying it first when absent or corrupt. */
export async function ensureTarball(
	lock: IdbLock,
	deps: TarballDeps
): Promise<{ path: string; source: "cache" | "download" }> {
	const path = cachePath(deps.home, lock.sha256);
	if (existsSync(path)) {
		if ((await sha256OfFile(path)) === lock.sha256) {
			deps.log(`cache hit: ${path}`);
			return { path, source: "cache" };
		}
		deps.log(`cache entry ${path} is corrupt, re-downloading`);
		await rm(path, { force: true });
	}
	const url = `https://github.com/facebook/idb/releases/download/${lock.version}/${lock.tarball}`;
	deps.log(`downloading ${url}`);
	const response = await deps.fetchImpl(url);
	if (!response.ok) throw new Error(`download failed: ${url} -> HTTP ${response.status}`);
	await mkdir(dirname(path), { recursive: true });
	const partial = `${path}.partial-${process.pid}`;
	await Bun.write(partial, response);
	const actual = await sha256OfFile(partial);
	if (actual !== lock.sha256) {
		await rm(partial, { force: true });
		throw new Error(`sha256 mismatch for ${lock.tarball} ${lock.version}: expected ${lock.sha256}, got ${actual}`);
	}
	await rename(partial, path);
	deps.log(`downloaded ${lock.tarball} (${lock.version}) -> ${path}`);
	return { path, source: "download" };
}

async function readStamp(dest: string): Promise<Stamp | undefined> {
	try {
		return stampSchema.parse(JSON.parse(await readFile(join(dest, STAMP_FILE), "utf8")));
	} catch {
		return undefined;
	}
}

function layoutProblem(dir: string): string | undefined {
	const missing = REQUIRED_FILES.filter((file) => !existsSync(join(dir, file)));
	return missing.length > 0 ? `library package is missing ${missing.join(", ")}` : undefined;
}

/** Validate `staged`, then swap it in for `dest` (the previous install survives a bad `staged`). */
async function swapIn(staged: string, dest: string, stamp: Stamp): Promise<void> {
	const problem = layoutProblem(staged);
	if (problem) {
		await rm(staged, { recursive: true, force: true });
		throw new Error(problem);
	}
	await writeFile(join(staged, STAMP_FILE), `${JSON.stringify(stamp, null, 2)}\n`);
	await rm(dest, { recursive: true, force: true });
	await rename(staged, dest);
}

/** Extract `tarball` into `dest` unless the stamp already says this exact release is installed. */
export async function installLibraries(
	lock: IdbLock,
	tarball: string,
	dest: string
): Promise<"installed" | "up-to-date"> {
	const stamp = await readStamp(dest);
	if (
		stamp?.source === "release" &&
		stamp.sha256 === lock.sha256 &&
		stamp.version === lock.version &&
		!layoutProblem(dest)
	) {
		return "up-to-date";
	}
	const staged = `${dest}.staging-${process.pid}`;
	await rm(staged, { recursive: true, force: true });
	await mkdir(staged, { recursive: true });
	const tar = Bun.spawn(["tar", "-xzf", tarball, "-C", staged], { stdout: "ignore", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(tar.stderr).text(), tar.exited]);
	if (code !== 0) {
		await rm(staged, { recursive: true, force: true });
		throw new Error(`tar -xzf ${tarball} failed (${code}): ${stderr.trim()}`);
	}
	await swapIn(staged, dest, { version: lock.version, source: "release", sha256: lock.sha256 });
	return "installed";
}

export const IDB_REPO = "https://github.com/facebook/idb.git";

export type SourceDeps = { exec: Exec; srcDir: string; dest: string; log: (line: string) => void };

async function run(exec: Exec, cmd: readonly string[], cwd?: string): Promise<string> {
	const result = await exec(cmd, { cwd });
	if (result.exitCode !== 0) throw new Error(execError(cmd, result));
	return result.stdout;
}

/** Shallow-clone idb at `version` into `srcDir` unless a checkout is already there; a failed clone leaves nothing. */
async function ensureCheckout(exec: Exec, srcDir: string, version: string, log: (line: string) => void): Promise<void> {
	if (existsSync(join(srcDir, ".git"))) return;
	log(`cloning idb ${version} (shallow) -> ${srcDir}`);
	await mkdir(dirname(srcDir), { recursive: true });
	const partial = `${srcDir}.partial-${process.pid}`;
	await rm(partial, { recursive: true, force: true });
	try {
		await run(exec, ["git", "clone", "--depth", "1", "--branch", version, IDB_REPO, partial]);
	} catch (error) {
		await rm(partial, { recursive: true, force: true });
		throw error;
	}
	await rename(partial, srcDir);
}

/** The tag the checkout's HEAD sits on; fetches the tag first when the shallow clone lacks it. */
async function checkoutTag(exec: Exec, idbDir: string, version: string): Promise<string> {
	const describe = ["git", "-C", idbDir, "describe", "--tags", "--exact-match"] as const;
	let result = await exec(describe);
	if (result.exitCode !== 0) {
		await run(exec, ["git", "-C", idbDir, "fetch", "--depth", "1", "origin", "tag", version]);
		result = await exec(describe);
	}
	if (result.exitCode !== 0) throw new Error(execError(describe, result));
	return result.stdout.trim();
}

/** Build the library package from an idb checkout at the lock tag (cloned on demand) with idb's `build.sh`. */
export async function buildFromSource(lock: IdbLock, deps: SourceDeps): Promise<void> {
	const { exec, srcDir, dest, log } = deps;
	await ensureCheckout(exec, srcDir, lock.version, log);
	const tag = await checkoutTag(exec, srcDir, lock.version);
	if (tag !== lock.version) {
		throw new Error(
			`idb checkout ${srcDir} is at ${tag} but idb.lock.json pins ${lock.version}: ` +
				`run \`git -C ${srcDir} fetch --depth 1 origin tag ${lock.version} && git -C ${srcDir} checkout ${lock.version}\` or update the lock`
		);
	}
	log(`building idb libraries ${lock.version} from source in ${srcDir} (this takes a while)`);
	await run(exec, ["./build.sh", "build", "libraries"], srcDir);
	await run(exec, ["./build.sh", "build", "library-package"], srcDir);
	const staged = `${dest}.staging-${process.pid}`;
	await rm(staged, { recursive: true, force: true });
	await cp(join(srcDir, "Build", "LibraryPackage"), staged, { recursive: true, verbatimSymlinks: true });
	await swapIn(staged, dest, { version: lock.version, source: "source" });
}

export const NATIVE_DIR = resolve(import.meta.dir, "..");

export async function main(argv: readonly string[]): Promise<number> {
	const unknown = argv.filter((arg) => arg !== "--from-source");
	if (unknown.length > 0) {
		console.error(`deps: unknown argument ${unknown.join(" ")}\nusage: bun native/scripts/deps.ts [--from-source]`);
		return 2;
	}
	const log = (line: string) => console.log(`deps: ${line}`);
	const lock = parseLock(await readFile(join(NATIVE_DIR, "idb.lock.json"), "utf8"));
	const dest = join(NATIVE_DIR, "idb-libraries");
	const home = process.env.HOME ?? homedir();
	if (argv.includes("--from-source")) {
		const srcDir = process.env.WARDEN_IDB_SRC || sourcePath(home, lock.version);
		await buildFromSource(lock, { exec: bunExec, srcDir, dest, log });
		log(`built ${lock.version} from source -> ${dest}`);
		return 0;
	}
	const tarball = await ensureTarball(lock, { home, fetchImpl: fetch, log });
	const outcome = await installLibraries(lock, tarball.path, dest);
	log(outcome === "up-to-date" ? `${dest} already at ${lock.version}` : `extracted ${lock.version} -> ${dest}`);
	return 0;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(`deps: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	);
}
