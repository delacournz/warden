#!/usr/bin/env bun
/**
 * `bun native/android/scripts/build.ts [--out <dir>]` — build `warden-uiad` without Gradle:
 *
 *   javac (JDK 11+)  native/android/src/**.java  ->  classes/
 *   d8 (SDK build-tools)  classes/  ->  dist/warden-uiad.dex
 *   dist/manifest.json   { protocol, version, bytes, dexSha256, sourceSha256, minApi, d8, javac, androidJar, builtAt }
 *
 * The SDK comes from `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`, then `~/Library/Android/sdk` / `~/Android/Sdk`; the
 * newest build-tools that has `d8` and the newest `platforms/android-N` (N >= 30) are used. Only public SDK
 * classes are linked: every hidden API in the server is reached through reflection.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { bunExec, type Exec, execError } from "@delacour/warden-core/exec";

const ANDROID_DIR = resolve(import.meta.dir, "..");
export const SOURCE_DIR = join(ANDROID_DIR, "src");
export const DEX_NAME = "warden-uiad.dex";
/** Lowest API level the dex is desugared for (`d8 --min-api`); the server only calls API 24-26 methods itself. */
export const MIN_API = 26;
/** Platforms older than this are not considered for `android.jar`. */
export const MIN_PLATFORM = 30;

export type Toolchain = {
	javac: string;
	d8: string;
	androidJar: string;
	buildTools: string;
	platform: string;
};

/** Numeric dotted compare (`36.0.0` > `34.0.0`, `37.1` > `37`); a missing part is 0. */
export function compareVersions(a: string, b: string): number {
	const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** The newest build-tools directory, preferring a stable one (`36.0.0`) over a preview (`36.0.0-rc5`). */
export function pickBuildTools(names: readonly string[]): string | undefined {
	const newest = (list: readonly string[]): string | undefined => [...list].sort((a, b) => compareVersions(b, a))[0];
	return newest(names.filter((name) => /^\d+(\.\d+)*$/.test(name))) ?? newest(names);
}

/** The newest `android-N[.M]` platform with `N >= minPlatform` (`android-37.1` beats `android-36`). */
export function pickPlatform(names: readonly string[], minPlatform: number = MIN_PLATFORM): string | undefined {
	const levels = names
		.map((name) => ({ name, level: /^android-(\d+(?:\.\d+)?)$/.exec(name)?.[1] }))
		.filter((entry): entry is { name: string; level: string } => entry.level !== undefined)
		.filter((entry) => Number.parseFloat(entry.level) >= minPlatform);
	return levels.sort((a, b) => compareVersions(b.level, a.level))[0]?.name;
}

/** Candidate SDK roots in order of preference. */
export function sdkRoots(env: Record<string, string | undefined>, home: string): string[] {
	const roots = [
		env.WARDEN_ANDROID_SDK,
		env.ANDROID_HOME,
		env.ANDROID_SDK_ROOT,
		join(home, "Library", "Android", "sdk"),
		join(home, "Android", "Sdk"),
	];
	return roots.filter((root): root is string => root !== undefined && root !== "");
}

function listDirs(path: string): string[] {
	try {
		return readdirSync(path);
	} catch {
		return [];
	}
}

/** Locate `javac`, `d8` and an `android.jar`, or say what is missing. */
export function findToolchain(
	env: Record<string, string | undefined>,
	home: string = homedir()
): { ok: true; toolchain: Toolchain } | { ok: false; missing: string[] } {
	const missing: string[] = [];
	const javaHome = env.JAVA_HOME;
	const javac = javaHome && existsSync(join(javaHome, "bin", "javac")) ? join(javaHome, "bin", "javac") : "javac";
	for (const sdk of sdkRoots(env, home)) {
		const tools = pickBuildTools(
			listDirs(join(sdk, "build-tools")).filter((n) => existsSync(join(sdk, "build-tools", n, "d8")))
		);
		const platform = pickPlatform(
			listDirs(join(sdk, "platforms")).filter((n) => existsSync(join(sdk, "platforms", n, "android.jar")))
		);
		if (tools && platform) {
			return {
				ok: true,
				toolchain: {
					javac,
					d8: join(sdk, "build-tools", tools, "d8"),
					androidJar: env.WARDEN_UIAD_ANDROID_JAR || join(sdk, "platforms", platform, "android.jar"),
					buildTools: tools,
					platform,
				},
			};
		}
		if (!tools) missing.push(`${sdk}: no build-tools with d8`);
		if (!platform) missing.push(`${sdk}: no platforms/android-${MIN_PLATFORM}+ with android.jar`);
	}
	if (missing.length === 0) missing.push("no Android SDK found (set ANDROID_HOME)");
	return { ok: false, missing };
}

/** Every `.java` under `dir`, sorted. */
export async function javaSources(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { recursive: true });
	return entries
		.filter((entry) => entry.endsWith(".java"))
		.map((entry) => join(dir, entry))
		.sort();
}

/** Hash of the source tree (paths relative to `dir` plus contents): the manifest field a freshness test compares. */
export function sourceHash(dir: string, files: readonly string[]): string {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(relative(dir, file));
		hash.update("\0");
		hash.update(readFileSync(file));
		hash.update("\0");
	}
	return hash.digest("hex");
}

export type Manifest = {
	protocol: number;
	version: string;
	bytes: number;
	dexSha256: string;
	sourceSha256: string;
	minApi: number;
	d8: string;
	javac: string;
	androidJar: string;
	builtAt: string;
};

async function run(exec: Exec, cmd: readonly string[]): Promise<string> {
	const result = await exec(cmd);
	if (result.exitCode !== 0) throw new Error(execError(cmd, result));
	return `${result.stdout}${result.stderr}`.trim();
}

/** Constants the Java side declares, so the manifest names the same protocol and version. */
export function readConstants(mainJava: string): { protocol: number; version: string } {
	const protocol = /PROTOCOL = (\d+);/.exec(mainJava)?.[1];
	const version = /VERSION = "([^"]+)";/.exec(mainJava)?.[1];
	if (!protocol || !version) throw new Error("Main.java: PROTOCOL / VERSION constants not found");
	return { protocol: Number(protocol), version };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const outIndex = argv.indexOf("--out");
	const dist = resolve(outIndex >= 0 ? (argv[outIndex + 1] ?? "") : join(ANDROID_DIR, "dist"));
	const found = findToolchain(process.env);
	if (!found.ok) {
		console.error(`build: Android toolchain not found:\n  ${found.missing.join("\n  ")}`);
		return 2;
	}
	const { toolchain } = found;
	const sources = await javaSources(SOURCE_DIR);
	if (sources.length === 0) throw new Error(`no .java files under ${SOURCE_DIR}`);
	const classes = join(dist, "classes");
	await rm(dist, { recursive: true, force: true });
	await mkdir(classes, { recursive: true });

	const t0 = performance.now();
	await run(bunExec, [
		toolchain.javac,
		"-source",
		"8",
		"-target",
		"8",
		"-Xlint:-options",
		"-bootclasspath",
		toolchain.androidJar,
		"-d",
		classes,
		...sources,
	]);
	const classFiles = (await readdir(classes, { recursive: true })).filter((f) => f.endsWith(".class")).sort();
	await run(bunExec, [
		toolchain.d8,
		"--release",
		"--min-api",
		String(MIN_API),
		"--lib",
		toolchain.androidJar,
		"--output",
		dist,
		...classFiles.map((file) => join(classes, file)),
	]);
	const dex = readFileSync(join(dist, "classes.dex"));
	await writeFile(join(dist, DEX_NAME), dex);
	await rm(join(dist, "classes.dex"));
	await rm(classes, { recursive: true, force: true });

	const constants = readConstants(readFileSync(join(SOURCE_DIR, "nz/co/delacour/warden/uiad/Main.java"), "utf8"));
	const manifest: Manifest = {
		...constants,
		bytes: dex.length,
		dexSha256: createHash("sha256").update(dex).digest("hex"),
		sourceSha256: sourceHash(SOURCE_DIR, sources),
		minApi: MIN_API,
		d8: `build-tools ${toolchain.buildTools}`,
		javac: (await run(bunExec, [toolchain.javac, "-version"])).split("\n")[0] ?? "javac",
		androidJar: toolchain.platform,
		builtAt: new Date().toISOString(),
	};
	await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	console.log(
		`build: ${DEX_NAME} ${dex.length} B (protocol ${manifest.protocol}, v${manifest.version}) in ${Math.round(performance.now() - t0)} ms; ${manifest.d8}, ${manifest.androidJar}, ${manifest.javac}`
	);
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
