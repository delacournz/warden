import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appFramework, nativeBundleIds } from "./native-ids";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-native-ids-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, text: string): void {
	mkdirSync(join(dir, path, ".."), { recursive: true });
	writeFileSync(join(dir, path), text);
}

describe("appFramework", () => {
	test("expo when package.json lists expo, react-native when only react-native, undefined otherwise", () => {
		expect(appFramework(dir)).toBeUndefined();
		write("package.json", JSON.stringify({ dependencies: { "react-native": "0.80" } }));
		expect(appFramework(dir)).toBe("react-native");
		write("package.json", JSON.stringify({ dependencies: { "react-native": "0.80", expo: "58" } }));
		expect(appFramework(dir)).toBe("expo");
		write("package.json", JSON.stringify({ devDependencies: { expo: "58" } }));
		expect(appFramework(dir)).toBe("expo");
	});
});

describe("nativeBundleIds", () => {
	const pbxproj = (id: string) => `
		buildSettings = {
			PRODUCT_BUNDLE_IDENTIFIER = "${id}";
			PRODUCT_NAME = Wallet;
		};
		buildSettings = {
			PRODUCT_BUNDLE_IDENTIFIER = "${id}Tests";
		};`;

	test("reads PRODUCT_BUNDLE_IDENTIFIER (not the test target's) and applicationId (groovy and kts)", () => {
		write("ios/Wallet.xcodeproj/project.pbxproj", pbxproj("com.x.wallet"));
		write("android/app/build.gradle", 'android {\n  defaultConfig {\n    applicationId "com.x.wallet.android"\n  }\n}');
		expect(nativeBundleIds(dir, "Wallet")).toEqual({ ios: "com.x.wallet", android: "com.x.wallet.android" });
		rmSync(join(dir, "android/app/build.gradle"));
		write("android/app/build.gradle.kts", 'defaultConfig {\n  applicationId = "com.x.kts"\n}');
		expect(nativeBundleIds(dir, "Wallet").android).toBe("com.x.kts");
	});

	test("the template's $(PRODUCT_NAME:rfc1034identifier) is filled in with the app name; Pods projects are ignored", () => {
		write(
			"ios/My App.xcodeproj/project.pbxproj",
			'PRODUCT_BUNDLE_IDENTIFIER = "org.reactjs.native.example.$(PRODUCT_NAME:rfc1034identifier)";'
		);
		write("ios/Pods/Pods.xcodeproj/project.pbxproj", 'PRODUCT_BUNDLE_IDENTIFIER = "org.cocoapods.x";');
		expect(nativeBundleIds(dir, "My App")).toEqual({ ios: "org.reactjs.native.example.My-App" });
	});

	test("an id still holding a build variable is left out; no native dirs = none", () => {
		write("ios/A.xcodeproj/project.pbxproj", "PRODUCT_BUNDLE_IDENTIFIER = $(APP_ID);");
		expect(nativeBundleIds(dir, "A")).toEqual({});
	});
});
