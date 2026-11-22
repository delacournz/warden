import { err, ok, type Result } from "@delacour/warden-types/result";
import type { Platform } from "../types";

/** An Android application id: two or more dot-separated segments, each a letter then letters, digits or `_`. */
const ANDROID_APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
/** An iOS bundle id: letters, digits, dots and hyphens, starting with a letter or digit (the config schema's rule). */
export const IOS_BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

const SHAPE: Record<Platform, { pattern: RegExp; words: string }> = {
	android: {
		pattern: ANDROID_APP_ID,
		words:
			"an Android application id is two or more dot-separated segments of letters, digits and underscores, each starting with a letter (com.example.app)",
	},
	ios: {
		pattern: IOS_BUNDLE_ID,
		words: "an iOS bundle id is letters, digits, dots and hyphens (com.example.app)",
	},
};

/**
 * `id` when it has the platform's app id shape, else an error that names `source`: where the id was read from
 * (`--bundle-id`, `--app`, `expo.android.package in the app config`). Every id warden hands to simctl, adb or a
 * build goes through this once, where it enters.
 */
export function checkAppId(id: string, platform: Platform, source: string): Result<string> {
	const { pattern, words } = SHAPE[platform];
	return pattern.test(id) ? ok(id) : err(`${JSON.stringify(id)} (from ${source}) is not a valid app id: ${words}`);
}
