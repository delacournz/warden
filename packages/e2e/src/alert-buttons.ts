import type { Element, Point } from "./driver/driver.types";

/**
 * Button names `device.alert("accept")` / `("dismiss")` look for, in order. The Android permission prompt's own
 * labels ("While using the app", "Only this time", "Don't allow") are here too; on Android `accept` and `dismiss` go
 * by the permission prompt's button ids first (`ANDROID_PERMISSION_ALLOW_IDS`, `ANDROID_PERMISSION_DENY_IDS`), which also
 * holds in other locales, then by these names, then by `AlertDialog`'s `button1` / `button2`. "Don't allow" is matched by
 * "Don't Allow" (names compare ignoring case).
 */
export const ACCEPT_BUTTONS = [
	"OK",
	"Allow",
	"Open",
	"Continue",
	"Yes",
	"Done",
	"Allow While Using App",
	"Allow Once",
	"While using the app",
	"Only this time",
];
export const DISMISS_BUTTONS = ["Cancel", "Don't Allow", "Not Now", "Dismiss", "No", "Close"];

function normalise(text: string): string {
	return text.replace(/[‘’]/g, "'").trim().toLowerCase();
}

export function nameOf(button: Element): string | undefined {
	return button.label ?? button.text ?? button.value;
}

/** The button called `wanted`, ignoring case and curly apostrophes. */
export function findButton(buttons: readonly Element[], wanted: string): Element | undefined {
	const target = normalise(wanted);
	return buttons.find((button) => {
		const name = nameOf(button);
		return name !== undefined && normalise(name) === target;
	});
}

export function firstOf(buttons: readonly Element[], names: readonly string[]): Element | undefined {
	for (const name of names) {
		const found = findButton(buttons, name);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** Where to tap an element: its own tap point, else the middle of its frame. */
export function centre(element: Element): Point {
	const { x, y, width, height } = element.frame;
	return element.tapPoint ?? { x: x + width / 2, y: y + height / 2 };
}

/**
 * The permission prompt's allow buttons, in the order `device.alert("accept")` tries them, the most lasting grant
 * first (API 30+ camera, mic and location prompts show "While using the app", "Only this time" and "Don't allow",
 * deny last, so the last button is the wrong guess). Going by id holds in other locales.
 */
export const ANDROID_PERMISSION_ALLOW_IDS: readonly string[] = [
	"permission_allow_button",
	"permission_allow_foreground_only_button",
	"permission_allow_one_time_button",
];

/** The permission prompt's deny buttons: the plain one before "don't ask again", which a later prompt could not undo. */
export const ANDROID_PERMISSION_DENY_IDS: readonly string[] = [
	"permission_deny_button",
	"permission_deny_and_dont_ask_again_button",
];

/**
 * `AlertDialog`'s positive (`button1`) and negative (`button2`) ids. Only a fallback after the names: React Native's
 * `Alert.alert` fills them by position, not by style (positive = last button, negative = second to last), so
 * `[OK, Cancel]` puts OK on `button2` and `[Cancel, Delete, Keep]` puts Delete there.
 */
export const ANDROID_POSITIVE_ID = "button1";
export const ANDROID_NEGATIVE_ID = "button2";

/**
 * Every id `device.alert("accept")` goes by on Android: the permission allow ids (before the names), then
 * `AlertDialog`'s positive `button1` (after the names).
 */
export const ANDROID_ALLOW_IDS: readonly string[] = [...ANDROID_PERMISSION_ALLOW_IDS, ANDROID_POSITIVE_ID];

/**
 * Every id `device.alert("dismiss")` goes by on Android: the permission deny ids (before the names), then
 * `AlertDialog`'s negative `button2` (after the names).
 */
export const ANDROID_DENY_IDS: readonly string[] = [...ANDROID_PERMISSION_DENY_IDS, ANDROID_NEGATIVE_ID];

/**
 * The ids of the Android autofill "Save password?" sheet's buttons (`autofill_save_no` "Never", `autofill_save_yes`
 * "Continue"). Either one marks the sheet, in any locale. Its two answers write to the user's account ("Never" a
 * permanent opt-out, "Continue" a stored password), so `device.alert` never presses them: both `accept` and `dismiss`
 * close the sheet with the Back key.
 */
export const ANDROID_AUTOFILL_SAVE_IDS: readonly string[] = ["autofill_save_no", "autofill_save_yes"];

/** Whether `buttons` belong to the Android autofill save sheet. */
export function isAutofillSaveSheet(buttons: readonly Element[]): boolean {
	return buttons.some((b) => b.identifier !== undefined && ANDROID_AUTOFILL_SAVE_IDS.includes(b.identifier));
}
