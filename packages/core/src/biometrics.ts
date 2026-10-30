/**
 * Biometric profiles. A profile with `biometrics: true` is a different device identity from the same profile
 * without it: pool matching, goldens and snapshots all key on the profile string, so enrolled and plain
 * devices never mix. The identity is the profile plus `+bio` (a character `profileSlug` never produces).
 */
export const BIOMETRIC_PROFILE_SUFFIX = "+bio";

/** Screen-lock PIN set on every biometrics device (Android needs a secure lock before it enrolls a fingerprint). */
export const BIOMETRIC_PIN = "1111";

/** Finger id `emu finger touch` presents once enrolled; `99` matches nothing. */
export const BIOMETRIC_FINGER_ID = 1;

export function biometricProfile(profile: string, biometrics: boolean): string {
	if (!biometrics || profile.endsWith(BIOMETRIC_PROFILE_SUFFIX)) return profile;
	return `${profile}${BIOMETRIC_PROFILE_SUFFIX}`;
}

export function splitBiometricProfile(profile: string): { profile: string; biometrics: boolean } {
	return profile.endsWith(BIOMETRIC_PROFILE_SUFFIX)
		? { profile: profile.slice(0, -BIOMETRIC_PROFILE_SUFFIX.length), biometrics: true }
		: { profile, biometrics: false };
}
