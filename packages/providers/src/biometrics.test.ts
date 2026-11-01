import { describe, expect, test } from "bun:test";
import { BIOMETRIC_PROFILE_SUFFIX, biometricProfiles } from "./biometrics";

describe("biometric profile identity", () => {
	test("biometrics off leaves the profile alone; on adds the suffix once", () => {
		expect(biometricProfiles.profile("pixel-8", false)).toBe("pixel-8");
		expect(biometricProfiles.profile("pixel-8", true)).toBe(`pixel-8${BIOMETRIC_PROFILE_SUFFIX}`);
		expect(biometricProfiles.profile("pixel-8+bio", true)).toBe("pixel-8+bio");
	});

	test("split inverts it", () => {
		expect(biometricProfiles.split("pixel-8")).toEqual({ profile: "pixel-8", biometrics: false });
		expect(biometricProfiles.split("pixel-8+bio")).toEqual({ profile: "pixel-8", biometrics: true });
	});

	test("enrolled and plain profiles never compare equal", () => {
		expect(biometricProfiles.profile("iphone-17", true)).not.toBe(biometricProfiles.profile("iphone-17", false));
	});
});
