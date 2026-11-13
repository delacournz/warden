import { describe, expect, test } from "bun:test";
import { ANDROID_NATIVE_PREPARE, defaultBuildCommand, IOS_NATIVE_PREPARE } from "./builds.defaults";

describe("defaultBuildCommand", () => {
	test("ios: generates the native project and installs pods only when they are missing or stale, then builds", () => {
		expect(IOS_NATIVE_PREPARE).toBe(
			"{ [ -f ios/Podfile ] || bunx expo prebuild --platform ios --no-install; } && " +
				"{ diff -q ios/Podfile.lock ios/Pods/Manifest.lock >/dev/null 2>&1 || pod install --project-directory=ios; }"
		);
		expect(defaultBuildCommand("ios", "Debug")).toBe(
			`${IOS_NATIVE_PREPARE} && bunx expo run:ios --no-install --no-bundler`
		);
		expect(defaultBuildCommand("ios", "Release")).toBe(
			`${IOS_NATIVE_PREPARE} && bunx expo run:ios --configuration Release --no-install --no-bundler`
		);
	});

	test("android: prebuilds when android/ is missing, then runs gradle alone (expo run:android would install on whatever device is booted)", () => {
		const abi = '-PreactNativeArchitectures="$([ "$(uname -m)" = arm64 ] && echo arm64-v8a || echo x86_64)"';
		expect(defaultBuildCommand("android", "Debug")).toBe(
			`${ANDROID_NATIVE_PREPARE} && cd android && ./gradlew app:assembleDebug ${abi}`
		);
		expect(defaultBuildCommand("android", "Release")).toBe(
			`${ANDROID_NATIVE_PREPARE} && cd android && ./gradlew app:assembleRelease ${abi}`
		);
		expect(defaultBuildCommand("android", "Release")).not.toContain("expo run:android");
	});
});
