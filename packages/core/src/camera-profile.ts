/**
 * Camera profiles. An Android profile with `camera: true` is a different device identity from the same profile
 * without it: the emulator's camera source is fixed at launch (`-camera-back imagefile:…`), so a camera emulator
 * is never reused as a plain one. The identity is the profile plus `+cam`, after `+bio` when both apply
 * (`<avd>+bio+cam`); callers that split `+bio` strip `+cam` first.
 */
export const CAMERA_PROFILE_SUFFIX = "+cam";

export function cameraProfile(profile: string, camera: boolean): string {
	if (!camera || profile.endsWith(CAMERA_PROFILE_SUFFIX)) return profile;
	return `${profile}${CAMERA_PROFILE_SUFFIX}`;
}

export function splitCameraProfile(profile: string): { profile: string; camera: boolean } {
	return profile.endsWith(CAMERA_PROFILE_SUFFIX)
		? { profile: profile.slice(0, -CAMERA_PROFILE_SUFFIX.length), camera: true }
		: { profile, camera: false };
}
