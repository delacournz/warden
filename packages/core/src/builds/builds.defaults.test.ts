import { describe, expect, test } from "bun:test";
import { defaultBuildCommand, IOS_NATIVE_PREPARE } from "./builds.defaults";

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

	test("android: expo run:android prebuilds on its own", () => {
		expect(defaultBuildCommand("android", "Debug")).toBe("bunx expo run:android --no-install --no-bundler");
		expect(defaultBuildCommand("android", "Release")).toBe(
			"bunx expo run:android --variant release --no-install --no-bundler"
		);
	});
});
