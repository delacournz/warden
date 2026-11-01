import { describe, expect, test } from "bun:test";
import { androidTools } from "./android-tools";

describe("androidTools", () => {
	test("uses ANDROID_HOME, then ANDROID_SDK_ROOT, then PATH names", () => {
		expect(androidTools({ ANDROID_HOME: "/a" })).toEqual({
			adb: "/a/platform-tools/adb",
			emulator: "/a/emulator/emulator",
		});
		expect(androidTools({ ANDROID_SDK_ROOT: "/b" }).adb).toBe("/b/platform-tools/adb");
		expect(androidTools({})).toEqual({ adb: "adb", emulator: "emulator" });
	});
});
