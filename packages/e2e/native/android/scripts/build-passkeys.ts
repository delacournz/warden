#!/usr/bin/env bun
/**
 * `bun native/android/scripts/build-passkeys.ts [--out <dir>] [--emit-ts [file]]` — build `warden-passkeys.apk`, the
 * virtual authenticator's credential provider (`nz.co.delacour.warden.passkeys`, API 34+), without Gradle:
 *
 *   passkeys.lock.json  exact versions, URLs and sha256 of androidx.credentials, androidx.biometric, kotlin-stdlib
 *   aapt2 compile+link  provider/res + libres (androidx.credentials' own R) + provider/AndroidManifest.xml
 *   javac               provider/src/**.java + the generated R against android.jar + the class jars
 *   R8 (build-tools lib/d8.jar)  classes + libraries, shrunk by rules.pro + aapt2's keep rules
 *   zip, zipalign, apksigner  with a debug key generated for the build (the driver compares versionName, not the signature)
 *
 * `--emit-ts` writes the APK as `src/driver/android/passkeys-apk.generated.ts` (size + hashes), which is how the
 * driver ships it. `versionName` is the first 12 digits of `sourceSha256`, so the driver can tell a stale install.
 * Downloads are cached in `native/android/.cache/passkeys`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { bunExec, type Exec, execError } from "@delacour/warden-core/exec";
import { compareVersions, findToolchain } from "./build";
import { fetchArtifact, parseLock, sha256Hex } from "./build-atf";

const ANDROID_DIR = resolve(import.meta.dir, "..");
export const PASSKEYS_DIR = join(ANDROID_DIR, "passkeys");
export const PROVIDER_DIR = join(PASSKEYS_DIR, "provider");
export const LIBRES_DIR = join(PASSKEYS_DIR, "libres");
export const PASSKEYS_LOCK = join(PASSKEYS_DIR, "passkeys.lock.json");
export const PASSKEYS_RULES = join(PASSKEYS_DIR, "rules.pro");
export const PASSKEYS_CACHE_DIR = join(ANDROID_DIR, ".cache", "passkeys");
/** The committed APK: the workspace reads it, the release ships it as the `warden-passkeys-<sha8>.apk` asset. */
export const PASSKEYS_CHECKED_IN_APK = join(PASSKEYS_DIR, "warden-passkeys.apk");
export const PASSKEYS_GENERATED_TS = resolve(ANDROID_DIR, "../../src/driver/android/passkeys-apk.generated.ts");
export const PASSKEYS_PACKAGE = "nz.co.delacour.warden.passkeys";
/** `minSdkVersion` / `targetSdkVersion` of the APK and R8's `--min-api`: the framework `CredentialProviderService` is API 34. */
export const PASSKEYS_MIN_SDK = 34;

/** Every input file of the APK, sorted: the provider sources + resources + manifest, libres, the lock and the rules. */
export async function passkeysInputs(dir: string = PASSKEYS_DIR): Promise<string[]> {
	const out: string[] = [];
	for (const sub of ["provider", "libres"]) {
		const entries = await readdir(join(dir, sub), { recursive: true });
		for (const entry of entries) {
			if (/\.(java|xml)$/.test(entry)) out.push(join(dir, sub, entry));
		}
	}
	out.push(join(dir, "passkeys.lock.json"), join(dir, "rules.pro"));
	return out.sort();
}

/** Hash of the inputs (paths relative to `dir` plus contents): what the freshness test and the install check compare. */
export function passkeysSourceHash(dir: string, files: readonly string[]): string {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(relative(dir, file)).update("\0").update(readFileSync(file)).update("\0");
	}
	return hash.digest("hex");
}

/** The `versionName` baked into the APK; `dumpsys package` shows it, so a driver can tell a stale install. */
export const passkeysVersionName = (sourceSha256: string): string => sourceSha256.slice(0, 12);

export function aapt2CompileArgv(aapt2: string, resDir: string, out: string): string[] {
	return [aapt2, "compile", "--dir", resDir, "-o", out];
}

export function aapt2LinkArgv(o: {
	aapt2: string;
	androidJar: string;
	manifest: string;
	genDir: string;
	rulesOut: string;
	versionName: string;
	out: string;
	resources: readonly string[];
}): string[] {
	return [
		o.aapt2,
		"link",
		"--extra-packages",
		"androidx.credentials",
		"-I",
		o.androidJar,
		"--manifest",
		o.manifest,
		"--java",
		o.genDir,
		"--min-sdk-version",
		String(PASSKEYS_MIN_SDK),
		"--target-sdk-version",
		String(PASSKEYS_MIN_SDK),
		"--version-code",
		"1",
		"--version-name",
		o.versionName,
		"--proguard",
		o.rulesOut,
		"-o",
		o.out,
		...o.resources,
	];
}

export function javacArgv(o: {
	javac: string;
	androidJar: string;
	classpath: readonly string[];
	out: string;
	sources: readonly string[];
}): string[] {
	return [
		o.javac,
		"-source",
		"11",
		"-target",
		"11",
		"-Xlint:-options",
		"-proc:none",
		"-cp",
		[o.androidJar, ...o.classpath].join(":"),
		"-d",
		o.out,
		...o.sources,
	];
}

export function r8Argv(o: {
	r8Jar: string;
	androidJar: string;
	rules: readonly string[];
	outDir: string;
	inputs: readonly string[];
}): string[] {
	return [
		"java",
		"-cp",
		o.r8Jar,
		"com.android.tools.r8.R8",
		"--release",
		"--min-api",
		String(PASSKEYS_MIN_SDK),
		"--lib",
		o.androidJar,
		"--no-minification",
		...o.rules.flatMap((rule) => ["--pg-conf", rule]),
		"--output",
		o.outDir,
		...o.inputs,
	];
}

export function keytoolArgv(keystore: string): string[] {
	return [
		"keytool",
		"-genkeypair",
		"-keystore",
		keystore,
		"-storepass",
		"android",
		"-keypass",
		"android",
		"-alias",
		"warden",
		"-keyalg",
		"RSA",
		"-keysize",
		"2048",
		"-validity",
		"10000",
		"-dname",
		"CN=warden passkeys debug",
	];
}

export function apksignerArgv(o: { apksigner: string; keystore: string; out: string; input: string }): string[] {
	return [
		o.apksigner,
		"sign",
		"--ks",
		o.keystore,
		"--ks-pass",
		"pass:android",
		"--key-pass",
		"pass:android",
		"--ks-key-alias",
		"warden",
		"--out",
		o.out,
		o.input,
	];
}

export type PasskeysManifest = {
	packageName: string;
	versionName: string;
	minSdk: number;
	bytes: number;
	apkSha256: string;
	sourceSha256: string;
	r8: string;
	builtAt: string;
};

/**
 * The generated module: the APK's size and hashes only. The bytes are `native/android/passkeys/warden-passkeys.apk`,
 * never inlined (a base64 zip in the bundle held npm's review for ~16 min): `passkeys-apk.ts` loads them.
 */
export function renderPasskeysGenerated(manifest: PasskeysManifest): string {
	return [
		"// GENERATED by `bun run --cwd packages/e2e android:emit-passkeys` from native/android/passkeys. Do not edit.",
		"// A test (passkeys-apk.test.ts) fails when the provider sources changed and this file did not.",
		"// The APK itself is native/android/passkeys/warden-passkeys.apk (a release asset, fetched on first use: passkeys-apk.ts).",
		"export const PASSKEYS_APK = {",
		`\tpackageName: ${JSON.stringify(manifest.packageName)},`,
		`\tversionName: ${JSON.stringify(manifest.versionName)},`,
		`\tminSdk: ${manifest.minSdk},`,
		`\tbytes: ${manifest.bytes},`,
		`\tapkSha256: ${JSON.stringify(manifest.apkSha256)},`,
		`\tsourceSha256: ${JSON.stringify(manifest.sourceSha256)},`,
		"} as const;",
		"",
	].join("\n");
}

async function run(exec: Exec, cmd: readonly string[], cwd?: string): Promise<string> {
	const result = await exec(cmd, cwd === undefined ? undefined : { cwd });
	if (result.exitCode !== 0) throw new Error(execError(cmd, result));
	return `${result.stdout}${result.stderr}`.trim();
}

async function sources(dir: string): Promise<string[]> {
	return (await readdir(dir, { recursive: true }))
		.filter((f) => f.endsWith(".java"))
		.map((f) => join(dir, f))
		.sort();
}

/** The lock's libraries as class jars: a jar as is, an AAR's `classes.jar` unzipped into `work`. */
async function libraryJars(lock: ReturnType<typeof parseLock>, work: string): Promise<string[]> {
	const jars: string[] = [];
	for (const artifact of lock.artifacts) {
		const file = await fetchArtifact(artifact, PASSKEYS_CACHE_DIR);
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
	return jars;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const outIndex = argv.indexOf("--out");
	const dist = resolve(outIndex >= 0 ? (argv[outIndex + 1] ?? "") : join(ANDROID_DIR, "dist-passkeys"));
	const found = findToolchain(process.env);
	if (!found.ok) {
		console.error(`build-passkeys: Android toolchain not found:\n  ${found.missing.join("\n  ")}`);
		return 2;
	}
	const { toolchain } = found;
	const platformLevel = toolchain.platform.replace(/^android-/, "");
	if (compareVersions(platformLevel, String(PASSKEYS_MIN_SDK)) < 0) {
		console.error(`build-passkeys: needs platforms/android-${PASSKEYS_MIN_SDK}+, found ${toolchain.platform}`);
		return 2;
	}
	const toolsDir = dirname(toolchain.d8);
	const tool = (name: string): string => join(toolsDir, name);
	const r8Jar = join(toolsDir, "lib", "d8.jar");
	for (const needed of [r8Jar, tool("aapt2"), tool("zipalign"), tool("apksigner")]) {
		if (!existsSync(needed)) {
			console.error(`build-passkeys: ${needed} not found in build-tools ${toolchain.buildTools}`);
			return 2;
		}
	}
	const t0 = performance.now();
	const lock = parseLock(readFileSync(PASSKEYS_LOCK, "utf8"));
	await rm(dist, { recursive: true, force: true });
	const work = join(dist, "work");
	await mkdir(join(work, "gen"), { recursive: true });
	await mkdir(join(work, "classes"), { recursive: true });

	const jars = await libraryJars(lock, work);

	const inputs = await passkeysInputs();
	const sourceSha256 = passkeysSourceHash(PASSKEYS_DIR, inputs);
	const versionName = passkeysVersionName(sourceSha256);
	const compiled = [join(work, "res.zip"), join(work, "libres.zip")];
	await run(bunExec, aapt2CompileArgv(tool("aapt2"), join(PROVIDER_DIR, "res"), compiled[0] ?? ""));
	await run(bunExec, aapt2CompileArgv(tool("aapt2"), LIBRES_DIR, compiled[1] ?? ""));
	await run(
		bunExec,
		aapt2LinkArgv({
			aapt2: tool("aapt2"),
			androidJar: toolchain.androidJar,
			manifest: join(PROVIDER_DIR, "AndroidManifest.xml"),
			genDir: join(work, "gen"),
			rulesOut: join(work, "aapt-rules.pro"),
			versionName,
			out: join(work, "base.apk"),
			resources: compiled,
		})
	);
	await run(
		bunExec,
		javacArgv({
			javac: toolchain.javac,
			androidJar: toolchain.androidJar,
			classpath: jars,
			out: join(work, "classes"),
			sources: [...(await sources(join(PROVIDER_DIR, "src"))), ...(await sources(join(work, "gen")))],
		})
	);
	const classFiles = (await readdir(join(work, "classes"), { recursive: true }))
		.filter((f) => f.endsWith(".class"))
		.sort()
		.map((f) => join(work, "classes", f));
	await run(
		bunExec,
		r8Argv({
			r8Jar,
			androidJar: toolchain.androidJar,
			rules: [PASSKEYS_RULES, join(work, "aapt-rules.pro")],
			outDir: work,
			inputs: [...classFiles, ...jars],
		})
	);
	await run(bunExec, ["cp", join(work, "base.apk"), join(work, "unsigned.apk")]);
	await run(bunExec, ["zip", "-q", "-j", "unsigned.apk", "classes.dex"], work);
	await run(bunExec, [tool("zipalign"), "-f", "-p", "4", join(work, "unsigned.apk"), join(work, "aligned.apk")]);
	const keystore = join(work, "debug.keystore");
	await run(bunExec, keytoolArgv(keystore));
	const apkPath = join(dist, "warden-passkeys.apk");
	await run(
		bunExec,
		apksignerArgv({ apksigner: tool("apksigner"), keystore, out: apkPath, input: join(work, "aligned.apk") })
	);
	const apk = readFileSync(apkPath);
	const manifest: PasskeysManifest = {
		packageName: PASSKEYS_PACKAGE,
		versionName,
		minSdk: PASSKEYS_MIN_SDK,
		bytes: apk.length,
		apkSha256: sha256Hex(apk),
		sourceSha256,
		r8: (await run(bunExec, ["java", "-cp", r8Jar, "com.android.tools.r8.R8", "--version"])).split("\n")[0] ?? "r8",
		builtAt: new Date().toISOString(),
	};
	await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	await rm(work, { recursive: true, force: true });
	const emitIndex = argv.indexOf("--emit-ts");
	if (emitIndex >= 0) {
		const next = argv[emitIndex + 1];
		const target = next !== undefined && !next.startsWith("--") ? resolve(next) : PASSKEYS_GENERATED_TS;
		await writeFile(target, renderPasskeysGenerated(manifest));
		await writeFile(PASSKEYS_CHECKED_IN_APK, apk);
		console.log(`build-passkeys: wrote ${relative(process.cwd(), target)}`);
	}
	console.log(
		`build-passkeys: warden-passkeys.apk ${apk.length} B (version ${versionName}) in ${Math.round(performance.now() - t0)} ms; ${manifest.r8}, ${toolchain.platform}`
	);
	return 0;
}

if (import.meta.main) {
	main().then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(`build-passkeys: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	);
}
