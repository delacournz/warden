import { chmodSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { BuildConfiguration } from "./builds.defaults";

/** The keystore a build was signed with, copied beside its APK in the cache. */
export const SIGNING_KEYSTORE = "signing.keystore";
/** Alias and passwords of `SIGNING_KEYSTORE`; owner-readable only, and never logged, traced or sent. */
export const SIGNING_FILE = "signing.json";

export type SigningKeystore = { path: string; alias: string; storePass: string; keyPass: string };

const DEBUG_DEFAULTS = { alias: "androiddebugkey", storePass: "android", keyPass: "android" } as const;

/** The body of `<name> { ... }` inside `text` (no nested braces in a signing config). */
function block(text: string, name: string): string | undefined {
	return new RegExp(`\\b${name}\\s*\\{([^{}]*)\\}`).exec(text)?.[1];
}

function quoted(body: string, key: string): string | undefined {
	return new RegExp(`\\b${key}\\s+['"]([^'"]+)['"]`).exec(body)?.[1];
}

/** `signingConfig signingConfigs.<name>` of the `debug` / `release` build type; absent = the type has none. */
function signingConfigName(gradle: string, configuration: BuildConfiguration): string | undefined {
	const type = block(gradle.slice(Math.max(0, gradle.indexOf("buildTypes"))), configuration.toLowerCase());
	return type === undefined ? undefined : /signingConfig\s+signingConfigs\.(\w+)/.exec(type)?.[1];
}

/**
 * The keystore Gradle signs `configuration` with in the prebuilt `<root>/android/app`: read from `build.gradle`'s
 * `signingConfigs` (Expo's template points release at `debug` + `debug.keystore`). Without a readable `build.gradle`, the
 * prebuild's own `debug.keystore` with the standard debug credentials. Undefined when the keystore file is missing or a
 * credential is not a literal (read from the environment): nothing a cache can keep.
 */
export function readProjectSigning(root: string, configuration: BuildConfiguration): SigningKeystore | undefined {
	const appDir = join(root, "android", "app");
	let gradle: string | undefined;
	try {
		gradle = readFileSync(join(appDir, "build.gradle"), "utf8");
	} catch {
		gradle = undefined;
	}
	const fallback = join(appDir, "debug.keystore");
	if (gradle === undefined) return existsSync(fallback) ? { path: fallback, ...DEBUG_DEFAULTS } : undefined;
	const name = signingConfigName(gradle, configuration) ?? "debug";
	const body = block(gradle.slice(Math.max(0, gradle.indexOf("signingConfigs"))), name);
	if (body === undefined) return undefined;
	const file = /\bstoreFile\s+file\(\s*['"]([^'"]+)['"]\s*\)/.exec(body)?.[1];
	const alias = quoted(body, "keyAlias");
	const storePass = quoted(body, "storePassword");
	const keyPass = quoted(body, "keyPassword");
	if (file === undefined || alias === undefined || storePass === undefined || keyPass === undefined) return undefined;
	const path = isAbsolute(file) ? file : join(appDir, file);
	return existsSync(path) ? { path, alias, storePass, keyPass } : undefined;
}

/** Copy `keystore` and its credentials into `dir` (the base APK's cache dir), owner-only. Best effort: no record = a cert-matched repack or a full build. */
export function cacheSigning(dir: string, keystore: SigningKeystore): void {
	try {
		const copy = join(dir, SIGNING_KEYSTORE);
		copyFileSync(keystore.path, copy);
		chmodSync(copy, 0o600);
		const record = join(dir, SIGNING_FILE);
		writeFileSync(
			record,
			`${JSON.stringify({ alias: keystore.alias, storePass: keystore.storePass, keyPass: keystore.keyPass })}\n`,
			{ mode: 0o600 }
		);
		chmodSync(record, 0o600);
	} catch {
		// best effort
	}
}

/** The keystore cached beside a base APK in `dir`; undefined for an imported base or a damaged record. */
export function readCachedSigning(dir: string): SigningKeystore | undefined {
	const path = join(dir, SIGNING_KEYSTORE);
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, SIGNING_FILE), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { alias, storePass, keyPass } = parsed as Record<string, unknown>;
		if (typeof alias !== "string" || typeof storePass !== "string" || typeof keyPass !== "string") return undefined;
		return { path, alias, storePass, keyPass };
	} catch {
		return undefined;
	}
}
