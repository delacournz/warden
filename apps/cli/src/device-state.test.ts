import { describe, expect, test } from "bun:test";
import { simctlDevicesJson } from "@delacour/warden-core/providers/ios.fixture";
import { deviceState } from "./device-state";
import { fakeExec } from "./testing";

const exec = fakeExec([
	[
		"xcrun simctl list devices -j",
		{
			stdout: simctlDevicesJson({
				"iOS-26-5": [
					{ udid: "ON", name: "a", state: "Booted" },
					{ udid: "OFF", name: "b", state: "Shutdown" },
				],
			}),
		},
	],
	["adb devices", { stdout: "List of devices attached\nemulator-5554\tdevice\n\n" }],
]);

describe("deviceState", () => {
	test("ios from simctl", async () => {
		expect(await deviceState(exec, {}, "ios", "ON")).toBe("booted");
		expect(await deviceState(exec, {}, "ios", "OFF")).toBe("shutdown");
		expect(await deviceState(exec, {}, "ios", "NOPE")).toBeUndefined();
	});

	test("android: listed by adb = booted, otherwise unknown", async () => {
		expect(await deviceState(exec, {}, "android", "emulator-5554")).toBe("booted");
		expect(await deviceState(exec, {}, "android", "emulator-5556")).toBeUndefined();
	});
});
