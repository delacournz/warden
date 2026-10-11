import { describe, expect, test } from "bun:test";
import { DEV_MENU_OFF, devClientLaunchArguments, leasedDevices } from "./launch";

describe("leasedDevices", () => {
	test("single mode: the whole pool", () => {
		expect(leasedDevices({ WARDEN_FLOW_PATHS: "e2e/a.e2e.ts", WARDEN_UDIDS: "A,B", WARDEN_UDID: "A" })).toEqual([
			"A",
			"B",
		]);
	});

	test("per-flow job: its own device, not the pool", () => {
		expect(leasedDevices({ WARDEN_UDIDS: "A,B", WARDEN_UDID: "B" })).toEqual(["B"]);
	});

	test("by hand: E2E_UDID; nothing set → none", () => {
		expect(leasedDevices({ E2E_UDID: "C" })).toEqual(["C"]);
		expect(leasedDevices({})).toEqual([]);
	});
});

describe("devClientLaunchArguments", () => {
	test("points the dev client at Metro with the dev menu off", () => {
		expect(devClientLaunchArguments("http://127.0.0.1:8090")).toEqual([
			"--initialUrl",
			"http://127.0.0.1:8090",
			...DEV_MENU_OFF,
		]);
	});
});
