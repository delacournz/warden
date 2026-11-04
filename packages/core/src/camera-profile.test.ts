import { describe, expect, test } from "bun:test";
import { biometricProfile, splitBiometricProfile } from "./biometrics";
import { CAMERA_PROFILE_SUFFIX, cameraProfile, splitCameraProfile } from "./camera-profile";

describe("camera profile identity", () => {
	test("off leaves the profile alone; on adds the suffix once", () => {
		expect(CAMERA_PROFILE_SUFFIX).toBe("+cam");
		expect(cameraProfile("pixel-10", false)).toBe("pixel-10");
		expect(cameraProfile("pixel-10", true)).toBe("pixel-10+cam");
		expect(cameraProfile("pixel-10+cam", true)).toBe("pixel-10+cam");
	});

	test("composes with +bio in canonical order <avd>+bio+cam", () => {
		expect(cameraProfile("x+bio", true)).toBe("x+bio+cam");
		expect(cameraProfile(biometricProfile("x", true), true)).toBe("x+bio+cam");
	});

	test("split inverts it", () => {
		expect(splitCameraProfile("x")).toEqual({ profile: "x", camera: false });
		expect(splitCameraProfile("x+cam")).toEqual({ profile: "x", camera: true });
		expect(splitCameraProfile("x+bio+cam")).toEqual({ profile: "x+bio", camera: true });
		expect(splitBiometricProfile(splitCameraProfile("x+bio+cam").profile)).toEqual({ profile: "x", biometrics: true });
	});

	test("plain, +bio, +cam and +bio+cam never compare equal", () => {
		const all = [cameraProfile("x", false), "x+bio", cameraProfile("x", true), cameraProfile("x+bio", true)];
		expect(new Set(all).size).toBe(4);
	});
});
