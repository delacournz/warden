import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseLock } from "./build-atf";
import {
	aapt2LinkArgv,
	javacArgv,
	PASSKEYS_DIR,
	PASSKEYS_LOCK,
	PASSKEYS_MIN_SDK,
	passkeysInputs,
	passkeysSourceHash,
	passkeysVersionName,
	r8Argv,
	renderPasskeysGenerated,
} from "./build-passkeys";

describe("the lock", () => {
	test("pins every library by exact version and sha256", () => {
		const lock = parseLock(readFileSync(PASSKEYS_LOCK, "utf8"));
		expect(lock.artifacts.map((a) => a.name)).toEqual(["androidx-credentials", "androidx-biometric", "kotlin-stdlib"]);
	});
});

describe("passkeysInputs", () => {
	test("lists the provider and libres sources, the lock and the rules, but not the test-only caller", async () => {
		const files = (await passkeysInputs()).map((f) => f.slice(PASSKEYS_DIR.length + 1));
		expect(files).toContain("provider/AndroidManifest.xml");
		expect(files).toContain("provider/src/nz/co/delacour/warden/passkeys/WardenPasskeyService.java");
		expect(files).toContain("libres/values/values.xml");
		expect(files).toContain("passkeys.lock.json");
		expect(files).toContain("rules.pro");
		expect(files.some((f) => f.startsWith("caller/"))).toBe(false);
		expect([...files].sort()).toEqual(files);
	});

	test("the hash is stable and changes with the sources", async () => {
		const files = await passkeysInputs();
		const hash = passkeysSourceHash(PASSKEYS_DIR, files);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(passkeysSourceHash(PASSKEYS_DIR, files)).toBe(hash);
		expect(passkeysSourceHash(PASSKEYS_DIR, files.slice(1))).not.toBe(hash);
	});
});

describe("argv builders", () => {
	test("aapt2 link bakes the version name and targets API 34", () => {
		const argv = aapt2LinkArgv({
			aapt2: "aapt2",
			androidJar: "android.jar",
			manifest: "m.xml",
			genDir: "gen",
			rulesOut: "r.pro",
			versionName: "abc123",
			out: "base.apk",
			resources: ["a.zip", "b.zip"],
		});
		expect(argv.slice(argv.indexOf("--version-name"), argv.indexOf("--version-name") + 2)).toEqual([
			"--version-name",
			"abc123",
		]);
		expect(argv[argv.indexOf("--min-sdk-version") + 1]).toBe(String(PASSKEYS_MIN_SDK));
		expect(argv.slice(-2)).toEqual(["a.zip", "b.zip"]);
	});

	test("javac compiles against android.jar and the libraries only", () => {
		const argv = javacArgv({
			javac: "javac",
			androidJar: "a.jar",
			classpath: ["x.jar", "y.jar"],
			out: "o",
			sources: ["A.java"],
		});
		expect(argv[argv.indexOf("-cp") + 1]).toBe("a.jar:x.jar:y.jar");
		expect(argv.at(-1)).toBe("A.java");
	});

	test("R8 takes every rule file and keeps names (no minification)", () => {
		const argv = r8Argv({
			r8Jar: "d8.jar",
			androidJar: "a.jar",
			rules: ["r1", "r2"],
			outDir: "out",
			inputs: ["c.class"],
		});
		expect(argv).toContain("--no-minification");
		expect(argv.filter((a) => a === "--pg-conf")).toHaveLength(2);
		expect(argv[argv.indexOf("--min-api") + 1]).toBe("34");
	});

	test("version name is the first 12 digits of the source hash", () => {
		expect(passkeysVersionName("0123456789abcdef")).toBe("0123456789ab");
	});
});

describe("renderPasskeysGenerated", () => {
	test("writes the module the driver imports", () => {
		const text = renderPasskeysGenerated({
			packageName: "p",
			versionName: "v",
			minSdk: 34,
			bytes: 3,
			apkSha256: "a",
			sourceSha256: "s",
			r8: "r",
			builtAt: "now",
		});
		expect(text).toContain("export const PASSKEYS_APK = {");
		expect(text).not.toContain("base64");
		expect(text).toContain('apkSha256: "a"');
		expect(text.endsWith("} as const;\n")).toBe(true);
	});
});
