import type { Element, Point } from "./driver/driver.types";

/**
 * Button names `device.alert("accept")` / `("dismiss")` look for, in order. The Android permission prompt's own
 * labels ("While using the app", "Only this time", "Don't allow") are here too; on Android `accept` goes by the
 * button id first (`ANDROID_ALLOW_IDS`), which also holds in other locales. "Don't allow" is matched by
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
