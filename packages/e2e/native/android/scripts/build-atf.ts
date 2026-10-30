#!/usr/bin/env bun
/**
 * `bun native/android/scripts/build-atf.ts [--out <dir>] [--emit-ts [file]]` — build `warden-atf`, the Accessibility
 * Test Framework (Apache-2.0) as a second, lazily pushed dex for `warden-uiad`'s `audit` op:
 *
 *   atf.lock.json   exact versions, URLs and sha256 of the framework and its runtime dependencies (a mismatch fails)
 *   javac           atf/src/**.java (the one entry class, `AtfAudit`) against android.jar + the framework
 *   R8 (build-tools lib/d8.jar)  entry class + framework + guava + protobuf-javalite + jsoup + androidx.core, shrunk
 *                   by atf/rules.pro (keeps the checks; `-dontobfuscate`)
 *   zip             classes.dex + the framework's English `resources/strings.xml` -> dist-atf/warden-atf.jar
 *
 * The result is a jar and not a bare `.dex` because the framework words its findings from `resources/strings.xml`,
 * read through the class loader; d8 drops resources (`MissingResourceException`), a jar keeps them.
 * Downloads are cached in `native/android/.cache/atf`. `--emit-ts` writes `src/driver/android/atf-dex.generated.ts`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { bunExec, type Exec, execError } from "@delacour/warden-core/exec";
import { findToolchain, MIN_API } from "./build";

const ANDROID_DIR = resolve(import.meta.dir, "..");
export const ATF_DIR = join(ANDROID_DIR, "atf");
export const ATF_SOURCE_DIR = join(ATF_DIR, "src");
export const ATF_LOCK = join(ATF_DIR, "atf.lock.json");
export const ATF_RULES = join(ATF_DIR, "rules.pro");
export const CACHE_DIR = join(ANDROID_DIR, ".cache", "atf");
export const ATF_JAR_NAME = "warden-atf.jar";
export const ATF_GENERATED_TS = resolve(ANDROID_DIR, "../../src/driver/android/atf-dex.generated.ts");

export type AtfArtifact = { name: string; kind: "aar" | "jar"; url: string; sha256: string };
export type AtfLock = { version: string; license: string; artifacts: AtfArtifact[] };

export function parseLock(text: string): AtfLock {
	const raw: unknown = JSON.parse(text);
	if (typeof raw !== "object" || raw === null) throw new Error("atf.lock.json: not an object");
	const { version, license, artifacts } = raw as Record<string, unknown>;
	if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
		throw new Error("atf.lock.json: version must be exact (x.y.z)");
	}
	if (typeof license !== "string") throw new Error("atf.lock.json: license missing");
	if (!Array.isArray(artifacts) || artifacts.length === 0) throw new Error("atf.lock.json: artifacts missing");
	const parsed = artifacts.map((entry: unknown): AtfArtifact => {
		const a = (entry ?? {}) as Record<string, unknown>;
		if (
			typeof a.name !== "string" ||
			(a.kind !== "aar" && a.kind !== "jar") ||
			typeof a.url !== "string" ||
			typeof a.sha256 !== "string"
		) {
			throw new Error(`atf.lock.json: bad artifact ${JSON.stringify(entry)}`);
		}
		if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error(`atf.lock.json: ${a.name}: sha256 must be 64 hex digits`);
		if (!a.url.startsWith("https://")) throw new Error(`atf.lock.json: ${a.name}: url must be https`);
		return { name: a.name, kind: a.kind, url: a.url, sha256: a.sha256 };
	});
	return { version, license, artifacts: parsed };
}

export function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function download(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

/** The artifact's file, from the cache when its hash matches, else downloaded; a hash mismatch throws. */
export async function fetchArtifact(
	artifact: AtfArtifact,
	cacheDir: string,
	fetchBytes: (url: string) => Promise<Uint8Array> = download
): Promise<string> {
	const file = join(cacheDir, `${artifact.name}.${artifact.kind}`);
	if (existsSync(file) && sha256Hex(readFileSync(file)) === artifact.sha256) return file;
	const bytes = await fetchBytes(artifact.url);
	const actual = sha256Hex(bytes);
	if (actual !== artifact.sha256) {
		throw new Error(
			`${artifact.name}: sha256 ${actual} does not match the lock (${artifact.sha256}) for ${artifact.url}`
		);
	}
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(file, bytes);
	return file;
}

/** The R8 argv: inputs are class jars, `rules` keeps the entry point and the checks. */
export function r8Argv(o: {
	java: string;
	r8Jar: string;
	androidJar: string;
	rules: string;
	outDir: string;
	inputs: readonly string[];
}): string[] {
	return [
		o.java,
		"-cp",
		o.r8Jar,
		"com.android.tools.r8.R8",
		"--release",
		"--min-api",
		String(MIN_API),
		"--lib",
		o.androidJar,
		"--pg-conf",
		o.rules,
		"--output",
		o.outDir,
		...o.inputs,
	];
}

async function run(exec: Exec, cmd: readonly string[], cwd?: string): Promise<string> {
	const result = await exec(cmd, cwd === undefined ? undefined : { cwd });
	if (result.exitCode !== 0) throw new Error(execError(cmd, result));
	return `${result.stdout}${result.stderr}`.trim();
}

export type AtfManifest = {
	version: string;
	bytes: number;
	jarSha256: string;
	dexBytes: number;
	sourceSha256: string;
	minApi: number;
	r8: string;
	builtAt: string;
};

/** Hash of what the jar is built from: the lock, the rules and the entry class. */
export function atfSourceHash(): string {
	const hash = createHash("sha256");
	for (const file of [ATF_LOCK, ATF_RULES, join(ATF_SOURCE_DIR, "nz/co/delacour/warden/atf/AtfAudit.java")]) {
		hash.update(relative(ATF_DIR, file)).update("\0").update(readFileSync(file)).update("\0");
	}
	return hash.digest("hex");
}

export function renderAtfGenerated(manifest: AtfManifest, jar: Uint8Array): string {
	return [
		"// GENERATED by `bun run --cwd packages/e2e android:emit-atf` from native/android/atf. Do not edit.",
		"// A test (atf-dex.test.ts) fails when the lock, the rules or the entry class changed and this file did not.",
		"export const ATF_DEX = {",
		`\tversion: ${JSON.stringify(manifest.version)},`,
		`\tbytes: ${manifest.bytes},`,
		`\tjarSha256: ${JSON.stringify(manifest.jarSha256)},`,
		`\tsourceSha256: ${JSON.stringify(manifest.sourceSha256)},`,
		`\tbase64: ${JSON.stringify(Buffer.from(jar).toString("base64"))},`,
		"} as const;",
		"",
	].join("\n");
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const outIndex = argv.indexOf("--out");
	const dist = resolve(outIndex >= 0 ? (argv[outIndex + 1] ?? "") : join(ANDROID_DIR, "dist-atf"));
	const found = findToolchain(process.env);
	if (!found.ok) {
		console.error(`build-atf: Android toolchain not found:\n  ${found.missing.join("\n  ")}`);
		return 2;
	}
	const { toolchain } = found;
	const r8Jar = join(dirname(toolchain.d8), "lib", "d8.jar");
	if (!existsSync(r8Jar)) {
		console.error(`build-atf: ${r8Jar} not found (R8 ships in the build-tools d8.jar)`);
		return 2;
	}
	const t0 = performance.now();
	const lock = parseLock(readFileSync(ATF_LOCK, "utf8"));
	await rm(dist, { recursive: true, force: true });
	const work = join(dist, "work");
	await mkdir(work, { recursive: true });

	const jars: string[] = [];
	for (const artifact of lock.artifacts) {
		const file = await fetchArtifact(artifact, CACHE_DIR);
		if (artifact.kind === "jar") {
			jars.push(file);
			continue;
		}
		const target = join(work, `${artifact.name}.jar`);
		const bytes = await new Response(
			Bun.spawn(["unzip", "-p", file, "classes.jar"], { stdout: "pipe" }).stdout
		).arrayBuffer();
		await writeFile(target, new Uint8Array(bytes));
		jars.push(target);
	}
	const atfJar = join(work, "accessibility-test-framework.jar");

	const classes = join(work, "classes");
	await mkdir(classes, { recursive: true });
	const sources = (await readdir(ATF_SOURCE_DIR, { recursive: true }))
		.filter((f) => f.endsWith(".java"))
		.map((f) => join(ATF_SOURCE_DIR, f));
	await run(bunExec, [
		toolchain.javac,
		"-source",
		"8",
		"-target",
		"8",
		"-Xlint:-options",
		"-bootclasspath",
		toolchain.androidJar,
		"-cp",
		jars.join(":"),
		"-d",
		classes,
		...sources,
	]);
	const entryJar = join(work, "entry.jar");
	await run(bunExec, ["jar", "cf", entryJar, "-C", classes, "."]);

	const dexOut = join(work, "dex");
	await mkdir(dexOut, { recursive: true });
	await run(
		bunExec,
		r8Argv({
			java: "java",
			r8Jar,
			androidJar: toolchain.androidJar,
			rules: ATF_RULES,
			outDir: dexOut,
			inputs: [entryJar, ...jars],
		})
	);
	const dex = readFileSync(join(dexOut, "classes.dex"));

	await run(bunExec, ["unzip", "-o", "-q", atfJar, "resources/strings.xml", "-d", dexOut]);
	const jarPath = join(dist, ATF_JAR_NAME);
	await run(bunExec, ["zip", "-q", "-X", "-r", jarPath, "classes.dex", "resources/strings.xml"], dexOut);
	const jar = readFileSync(jarPath);
	const manifest: AtfManifest = {
		version: lock.version,
		bytes: jar.length,
		jarSha256: sha256Hex(jar),
		dexBytes: dex.length,
		sourceSha256: atfSourceHash(),
		minApi: MIN_API,
		r8: (await run(bunExec, ["java", "-cp", r8Jar, "com.android.tools.r8.R8", "--version"])).split("\n")[0] ?? "r8",
		builtAt: new Date().toISOString(),
	};
	await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	await rm(work, { recursive: true, force: true });
	const emitIndex = argv.indexOf("--emit-ts");
	if (emitIndex >= 0) {
		const next = argv[emitIndex + 1];
		const target = next !== undefined && !next.startsWith("--") ? resolve(next) : ATF_GENERATED_TS;
		await writeFile(target, renderAtfGenerated(manifest, jar));
		console.log(`build-atf: wrote ${relative(process.cwd(), target)}`);
	}
	console.log(
		`build-atf: ${ATF_JAR_NAME} ${jar.length} B (dex ${dex.length} B, ATF ${lock.version}) in ${Math.round(performance.now() - t0)} ms; ${manifest.r8}`
	);
	return 0;
}

if (import.meta.main) {
	main().then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(`build-atf: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	);
}
