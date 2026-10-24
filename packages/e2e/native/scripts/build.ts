#!/usr/bin/env bun
/**
 * `bun native/scripts/build.ts` — release-build `warden-simd` and stage `native/dist/`:
 *
 *   dist/warden-simd                                  stripped, ad-hoc signed
 *   dist/Resources/SimulatorFrameworkBridge-iOS       idb's prebuilt in-sim guest, copied unchanged (never re-signed)
 *   dist/{CoreSimulatorStub,AccessibilityPlatformTranslationStub}.framework   ad-hoc signed
 *   dist/manifest.json                                { version, idb, xcode, builtAt }
 *
 * Requires `native/idb-libraries/` (run `bun native/scripts/deps.ts` first).
 */
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { bunExec, type Exec, execError } from "@delacour/warden-core/exec";
import { type IdbLock, parseLock } from "./deps";

const NATIVE_DIR = resolve(import.meta.dir, "..");
const WIRE_SWIFT = join(NATIVE_DIR, "ios", "Sources", "warden-simd", "Protocol", "Wire.swift");
const PRODUCT = "warden-simd";

/** `BuildInfo.idb` in Wire.swift is what `health` reports; it must be the version the libraries were pinned to. */
export function checkIdbConstant(wireSwift: string, lock: IdbLock): void {
	const match = wireSwift.match(/static let idb = "([^"]+)"/);
	if (!match) throw new Error("BuildInfo.idb not found in Protocol/Wire.swift");
	if (match[1] !== lock.version) {
		throw new Error(`BuildInfo.idb is ${match[1]} but idb.lock.json pins ${lock.version}: update Protocol/Wire.swift`);
	}
}

/** `xcodebuild -version` output → `26.6 (17F113)`. */
export function parseXcodeVersion(output: string): string {
	const version = output.match(/^Xcode (\S+)/m)?.[1];
	const build = output.match(/^Build version (\S+)/m)?.[1];
	if (!version) return "unknown";
	return build ? `${version} (${build})` : version;
}

/**
 * `otool -l` output → throws unless the binary has an `LC_RPATH` of its own directory. The stub frameworks are
 * linked as `@rpath/…` and staged beside the binary; Xcode 27's SwiftPM stopped adding that rpath itself
 * (Package.swift's `linkerSettings` does), and the failure is a dyld abort only at first launch.
 */
export function checkRpath(otoolLoadCommands: string): void {
	const rpaths = [...otoolLoadCommands.matchAll(/cmd LC_RPATH[\s\S]*?path (\S+) \(offset/g)].map((m) => m[1]);
	if (!rpaths.some((p) => p === "@executable_path" || p === "@loader_path")) {
		throw new Error(
			`warden-simd has no @executable_path rpath (has: ${rpaths.join(", ") || "none"}): the stub frameworks beside it would not load`
		);
	}
}

export type Manifest = { version: string; idb: string; xcode: string; builtAt: string };

export function buildManifest(input: { version: string; lock: IdbLock; xcode: string; now: Date }): Manifest {
	return { version: input.version, idb: input.lock.version, xcode: input.xcode, builtAt: input.now.toISOString() };
}

export type StagePlan = {
	copies: { from: string; to: string }[];
	strip: string[];
	sign: string[];
};

/** What goes into `dist/`, what is stripped, what is signed. Strip precedes sign (strip invalidates a signature). */
export function stageSteps(input: {
	binDir: string;
	libraries: string;
	dist: string;
	frameworks: string[];
}): StagePlan {
	const { binDir, libraries, dist, frameworks } = input;
	const binary = join(dist, PRODUCT);
	const guest = join("Resources", "SimulatorFrameworkBridge-iOS");
	return {
		copies: [
			{ from: join(binDir, PRODUCT), to: binary },
			{ from: join(libraries, guest), to: join(dist, guest) },
			...frameworks.map((framework) => ({ from: join(binDir, framework), to: join(dist, framework) })),
		],
		strip: [binary],
		sign: [...frameworks.map((framework) => join(dist, framework)), binary],
	};
}

async function run(exec: Exec, cmd: readonly string[], cwd?: string): Promise<string> {
	const result = await exec(cmd, { cwd });
	if (result.exitCode !== 0) throw new Error(execError(cmd, result));
	return result.stdout;
}

export async function main(): Promise<number> {
	const log = (line: string) => console.log(`build: ${line}`);
	const lock = parseLock(await readFile(join(NATIVE_DIR, "idb.lock.json"), "utf8"));
	const libraries = join(NATIVE_DIR, "idb-libraries");
	if (!existsSync(join(libraries, "Package.swift"))) {
		throw new Error("native/idb-libraries is missing: run `bun run --cwd packages/e2e native:deps` first");
	}
	checkIdbConstant(await readFile(WIRE_SWIFT, "utf8"), lock);

	const exec = bunExec;
	const packagePath = join(NATIVE_DIR, "ios");
	log("swift build -c release");
	await run(exec, ["swift", "build", "-c", "release", "--package-path", packagePath, "--product", PRODUCT]);
	const binDir = (
		await run(exec, ["swift", "build", "-c", "release", "--package-path", packagePath, "--show-bin-path"])
	).trim();

	checkRpath(await run(exec, ["otool", "-l", join(binDir, PRODUCT)]));
	const frameworks = (await readdir(binDir)).filter((name) => name.endsWith(".framework")).sort();
	if (frameworks.length === 0) throw new Error(`no stub frameworks next to the binary in ${binDir}`);
	const dist = join(NATIVE_DIR, "dist");
	await rm(dist, { recursive: true, force: true });
	await mkdir(join(dist, "Resources"), { recursive: true });

	const plan = stageSteps({ binDir, libraries, dist, frameworks });
	for (const { from, to } of plan.copies) await cp(from, to, { recursive: true, verbatimSymlinks: true });
	for (const path of plan.strip) await run(exec, ["strip", "-x", path]);
	for (const path of plan.sign) await run(exec, ["codesign", "-s", "-", "--force", path]);

	const xcode = parseXcodeVersion((await exec(["xcodebuild", "-version"])).stdout);
	const version = (await run(exec, [join(dist, PRODUCT), "--version"])).trim();
	const manifest = buildManifest({ version: version.split(" ")[1] ?? "unknown", lock, xcode, now: new Date() });
	await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	log(`${basename(dist)}/: ${version}; ${frameworks.join(", ")}; xcode ${xcode}`);
	return 0;
}

if (import.meta.main) {
	main().then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(`build: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	);
}
