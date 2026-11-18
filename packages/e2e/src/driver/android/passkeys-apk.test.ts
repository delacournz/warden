import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
	PASSKEYS_DIR,
	passkeysInputs,
	passkeysSourceHash,
	passkeysVersionName,
} from "../../../native/android/scripts/build-passkeys";
import { WORKSPACE_PASSKEYS_APK } from "./passkeys-apk";
import { PASSKEYS_APK } from "./passkeys-apk.generated";

describe("the generated provider APK module", () => {
	test("is built from the sources that are checked in", async () => {
		// when this fails: `bun run --cwd packages/e2e android:emit-passkeys` (needs the Android SDK build-tools), commit the result
		const hash = passkeysSourceHash(PASSKEYS_DIR, await passkeysInputs());
		expect<string>(PASSKEYS_APK.sourceSha256).toBe(hash);
		expect<string>(PASSKEYS_APK.versionName).toBe(passkeysVersionName(hash));
	});

	test("the checked-in APK is the one the module declares", () => {
		const apk = readFileSync(WORKSPACE_PASSKEYS_APK);
		expect(apk.length).toBe(PASSKEYS_APK.bytes);
		expect(createHash("sha256").update(apk).digest("hex")).toBe(PASSKEYS_APK.apkSha256);
		expect(apk.subarray(0, 2).toString("latin1")).toBe("PK");
	});

	test("carries no bytes: an inlined archive held npm's review for ~16 min", () => {
		expect(Object.keys(PASSKEYS_APK)).not.toContain("base64");
	});

	test("targets API 34 and the package the core undo uninstalls", async () => {
		const { PASSKEY_PROVIDER_PACKAGE } = await import("@delacour/warden-core/conditions/conditions.types");
		expect<string>(PASSKEYS_APK.packageName).toBe(PASSKEY_PROVIDER_PACKAGE);
		expect(PASSKEYS_APK.minSdk).toBe(34);
	});
});
