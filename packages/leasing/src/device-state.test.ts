import { describe, expect, test } from "bun:test";
import { simctlFixtures } from "@delacour/warden-providers/testing/ios.fixture";
import { fakeExec } from "@delacour/warden-runtime/testing/exec.testing";
import { DeviceStateProbe } from "./device-state";

const exec = fakeExec.build([
	[
		"xcrun simctl list devices -j",
		{
			stdout: simctlFixtures.devicesJson({
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
		expect(await new DeviceStateProbe({ exec: exec, env: {} }).state("ios", "ON")).toBe("booted");
		expect(await new DeviceStateProbe({ exec: exec, env: {} }).state("ios", "OFF")).toBe("shutdown");
		expect(await new DeviceStateProbe({ exec: exec, env: {} }).state("ios", "NOPE")).toBeUndefined();
	});

	test("android: listed by adb = booted, otherwise unknown", async () => {
		expect(await new DeviceStateProbe({ exec: exec, env: {} }).state("android", "emulator-5554")).toBe("booted");
		expect(await new DeviceStateProbe({ exec: exec, env: {} }).state("android", "emulator-5556")).toBeUndefined();
	});
});
