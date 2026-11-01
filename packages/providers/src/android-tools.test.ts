import { describe, expect, test } from "bun:test";
import { androidToolsLocator } from "./android-tools";

describe("androidTools", () => {
	test("uses ANDROID_HOME, then ANDROID_SDK_ROOT, then PATH names", () => {
		expect(androidToolsLocator.locate({ ANDROID_HOME: "/a" })).toEqual({
			adb: "/a/platform-tools/adb",
			emulator: "/a/emulator/emulator",
		});
		expect(androidToolsLocator.locate({ ANDROID_SDK_ROOT: "/b" }).adb).toBe("/b/platform-tools/adb");
		expect(androidToolsLocator.locate({})).toEqual({ adb: "adb", emulator: "emulator" });
	});
});
