/**
 * Traits a driver adds to a text input when it knows whether the field shows its placeholder (Android: the server's
 * `AccessibilityNodeInfo.isShowingHintText()`, API 26+). With neither, `screen/nodes.ts` falls back to comparing the
 * shown text with the placeholder, which cannot tell an empty field from one holding exactly the placeholder's text.
 */

/** The field is empty and shows its placeholder; the driver reports no value or text for it. */
export const SHOWING_HINT_TRAIT = "showing-hint";

/** The field holds text, which is its value even when it equals the placeholder. */
export const NOT_SHOWING_HINT_TRAIT = "not-showing-hint";
