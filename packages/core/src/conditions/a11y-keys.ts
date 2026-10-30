import type { A11yCondition } from "./conditions.types";

/**
 * Accessibility settings that live in `defaults` / `settings` rather than `simctl ui` or `font_scale`. Shared by the
 * e2e driver (apply) and condition undo (reset), so the two can never name different keys.
 */

export const IOS_A11Y_DOMAIN = "com.apple.Accessibility";

/** Condition field to the `com.apple.Accessibility` key it sets on a simulator (applied live, no relaunch). */
export const IOS_A11Y_DEFAULTS = {
	reduceMotion: "ReduceMotionEnabled",
	boldText: "EnhancedTextLegibilityEnabled",
	reduceTransparency: "EnhancedBackgroundContrastEnabled",
	buttonShapes: "ButtonShapesEnabled",
	differentiateWithoutColor: "DifferentiateWithoutColor",
	onOffLabels: "IncreaseButtonLegibilityEnabled",
	screenReader: "VoiceOverTouchEnabled",
} as const;

export type IosDefaultsField = keyof typeof IOS_A11Y_DEFAULTS;

export const IOS_DEFAULTS_FIELDS = Object.keys(IOS_A11Y_DEFAULTS) as IosDefaultsField[];

const spawnDefaults = (udid: string, ...args: string[]): string[] => [
	"xcrun",
	"simctl",
	"spawn",
	udid,
	"defaults",
	...args,
];

/**
 * One `simctl spawn <udid> defaults write` per entry. Not batched through `sh -c`: `simctl spawn` runs the
 * simulator's own `defaults` only when it resolves the bare name itself (verified on iOS 26: `/usr/bin/defaults` and a
 * shell both fail with "Could not write domain" / a dyld abort).
 */
export function iosDefaultsWriteArgvs(
	udid: string,
	entries: readonly (readonly [IosDefaultsField, boolean])[]
): string[][] {
	return entries.map(([field, on]) =>
		spawnDefaults(udid, "write", IOS_A11Y_DOMAIN, IOS_A11Y_DEFAULTS[field], "-bool", on ? "YES" : "NO")
	);
}

/** `defaults delete` per field; a key that is not there exits 1, which the caller must tolerate (`iosDefaultsMissing`). */
export function iosDefaultsDeleteArgvs(udid: string, fields: readonly IosDefaultsField[]): string[][] {
	return fields.map((field) => spawnDefaults(udid, "delete", IOS_A11Y_DOMAIN, IOS_A11Y_DEFAULTS[field]));
}

/** `defaults delete` of a key that was never written prints "does not exist", or "Domain not found" when the whole domain is empty (exit 1): already as wanted. */
export const iosDefaultsMissing = (stderr: string): boolean => /does not exist|not found/i.test(stderr);

/** The defaults-backed fields a recorded condition holds, i.e. the keys warden wrote (and may delete). */
export function iosDefaultsFields(record: A11yCondition): IosDefaultsField[] {
	return IOS_DEFAULTS_FIELDS.filter((field) => record[field] !== undefined);
}

/** `settings put` argvs (no `adb shell` prefix) that undo the Android-only fields a recorded condition holds. */
export function androidA11yResets(record: A11yCondition): string[][] {
	const resets: string[][] = [];
	if (record.highContrastText !== undefined) {
		resets.push(["settings", "put", "secure", "high_text_contrast_enabled", "0"]);
	}
	if (record.colorInversion !== undefined) {
		resets.push(["settings", "put", "secure", "accessibility_display_inversion_enabled", "0"]);
	}
	if (record.reduceMotion !== undefined)
		resets.push(["settings", "put", "global", "transition_animation_scale", "1.0"]);
	return resets;
}

/** `'…'` for a remote shell: an Android service component can hold `$` (inner classes). */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** Android setting names TalkBack mode writes. */
export const ANDROID_SERVICES_KEY = "enabled_accessibility_services";
export const ANDROID_A11Y_ENABLED_KEY = "accessibility_enabled";

/** The `settings` argv (no `adb shell` prefix) that sets a secure key to `value`, or deletes it when it was unset. */
export function androidSecureRestoreArgv(key: string, value: string | null): string[] {
	return value === null ? ["settings", "delete", "secure", key] : ["settings", "put", "secure", key, shellQuote(value)];
}

/**
 * TalkBack mode on Android: put back the accessibility services and master switch that were there before. Nothing
 * when the record has no `screenReaderPrevious` (warden did not turn a screen reader on, so it has nothing to restore).
 */
export function androidScreenReaderResets(record: A11yCondition): string[][] {
	if (record.screenReader !== true || record.screenReaderPrevious === undefined) return [];
	const { services, enabled } = record.screenReaderPrevious;
	return [
		androidSecureRestoreArgv(ANDROID_SERVICES_KEY, services),
		androidSecureRestoreArgv(ANDROID_A11Y_ENABLED_KEY, enabled),
	];
}
