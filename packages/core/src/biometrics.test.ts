import { describe, expect, test } from "bun:test";
import { BIOMETRIC_PROFILE_SUFFIX, biometricProfile, splitBiometricProfile } from "./biometrics";

describe("biometric profile identity", () => {
	test("biometrics off leaves the profile alone; on adds the suffix once", () => {
		expect(biometricProfile("pixel-8", false)).toBe("pixel-8");
		expect(biometricProfile("pixel-8", true)).toBe(`pixel-8${BIOMETRIC_PROFILE_SUFFIX}`);
		expect(biometricProfile("pixel-8+bio", true)).toBe("pixel-8+bio");
	});

	test("split inverts it", () => {
		expect(splitBiometricProfile("pixel-8")).toEqual({ profile: "pixel-8", biometrics: false });
		expect(splitBiometricProfile("pixel-8+bio")).toEqual({ profile: "pixel-8", biometrics: true });
	});

	test("enrolled and plain profiles never compare equal", () => {
		expect(biometricProfile("iphone-17", true)).not.toBe(biometricProfile("iphone-17", false));
	});
});
