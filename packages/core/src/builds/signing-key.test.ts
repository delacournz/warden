import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheSigning, readCachedSigning, readProjectSigning, SIGNING_FILE, SIGNING_KEYSTORE } from "./signing-key";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "signing-key-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const EXPO_GRADLE = `
android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
        upload {
            storeFile file("upload.jks")
            storePassword "up-store"
            keyAlias "up"
            keyPassword "up-key"
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            signingConfig signingConfigs.upload
            minifyEnabled true
        }
    }
}
`;

function project(gradle: string | undefined, files: string[] = ["debug.keystore", "upload.jks"]): string {
	const root = join(dir, "app");
	mkdirSync(join(root, "android", "app"), { recursive: true });
	if (gradle !== undefined) writeFileSync(join(root, "android", "app", "build.gradle"), gradle);
	for (const f of files) writeFileSync(join(root, "android", "app", f), "ks");
	return root;
}

describe("readProjectSigning", () => {
	test("the signing config the configuration's build type names, with its keystore path and credentials", () => {
		const root = project(EXPO_GRADLE);
		expect(readProjectSigning(root, "Debug")).toEqual({
			path: join(root, "android", "app", "debug.keystore"),
			alias: "androiddebugkey",
			storePass: "android",
			keyPass: "android",
		});
		expect(readProjectSigning(root, "Release")).toEqual({
			path: join(root, "android", "app", "upload.jks"),
			alias: "up",
			storePass: "up-store",
			keyPass: "up-key",
		});
	});

	test("a release type with no signingConfig uses the debug config", () => {
		const gradle = EXPO_GRADLE.replace("signingConfig signingConfigs.upload", "");
		const root = project(gradle);
		expect(readProjectSigning(root, "Release")?.alias).toBe("androiddebugkey");
	});

	test("no build.gradle but the prebuild's debug.keystore: the standard debug credentials", () => {
		const root = project(undefined);
		expect(readProjectSigning(root, "Release")).toEqual({
			path: join(root, "android", "app", "debug.keystore"),
			alias: "androiddebugkey",
			storePass: "android",
			keyPass: "android",
		});
	});

	test("credentials read from the environment cannot be cached: undefined", () => {
		const gradle = EXPO_GRADLE.replace('storePassword "up-store"', 'storePassword System.getenv("PW")');
		expect(readProjectSigning(project(gradle), "Release")).toBeUndefined();
	});

	test("a missing keystore file is undefined", () => {
		expect(readProjectSigning(project(EXPO_GRADLE, ["debug.keystore"]), "Release")).toBeUndefined();
	});

	test("no android/ at all is undefined", () => {
		expect(readProjectSigning(join(dir, "nothing"), "Release")).toBeUndefined();
	});
});

describe("cacheSigning / readCachedSigning", () => {
	const ks = () => {
		const path = join(dir, "src.keystore");
		writeFileSync(path, "keystore-bytes");
		return { path, alias: "a", storePass: "sp", keyPass: "kp" };
	};

	test("round-trips next to the base APK, owner-only, pointing at the cached copy", () => {
		const base = join(dir, "cache");
		mkdirSync(base);
		cacheSigning(base, ks());
		const cached = readCachedSigning(base);
		expect(cached).toEqual({ path: join(base, SIGNING_KEYSTORE), alias: "a", storePass: "sp", keyPass: "kp" });
		expect(readFileSync(join(base, SIGNING_KEYSTORE), "utf8")).toBe("keystore-bytes");
		expect(statSync(join(base, SIGNING_KEYSTORE)).mode & 0o077).toBe(0);
		expect(statSync(join(base, SIGNING_FILE)).mode & 0o077).toBe(0);
	});

	test("an imported base has no keystore: undefined", () => {
		expect(readCachedSigning(dir)).toBeUndefined();
	});

	test("a damaged record or a missing keystore is undefined, never a throw", () => {
		const base = join(dir, "cache");
		mkdirSync(base);
		writeFileSync(join(base, SIGNING_FILE), "{not json");
		expect(readCachedSigning(base)).toBeUndefined();
		cacheSigning(base, ks());
		rmSync(join(base, SIGNING_KEYSTORE));
		expect(existsSync(join(base, SIGNING_FILE))).toBe(true);
		expect(readCachedSigning(base)).toBeUndefined();
	});

	test("a failed copy is best effort", () => {
		expect(() => cacheSigning(join(dir, "missing-dir"), ks())).not.toThrow();
	});
});
