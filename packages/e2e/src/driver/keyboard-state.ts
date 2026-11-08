import type { Element, Rect, Snapshot } from "./driver.types";

/**
 * The on-screen keyboard of a snapshot: the largest `keyboard` element with a frame on the screen. A keyboard slid
 * off the bottom (iOS keeps the hidden one in the tree) is not on screen.
 */
export function keyboardElement(snapshot: Snapshot): Element | undefined {
	const { height } = snapshot.screen;
	const onScreen = snapshot.flat.filter(
		(e) =>
			e.role === "keyboard" &&
			e.hidden !== true &&
			e.frame.width > 0 &&
			e.frame.height > 0 &&
			(height <= 0 || (e.frame.y < height && e.frame.y + e.frame.height > 0))
	);
	return onScreen.sort((a, b) => b.frame.width * b.frame.height - a.frame.width * a.frame.height)[0];
}

export function keyboardVisible(snapshot: Snapshot): boolean {
	return keyboardElement(snapshot) !== undefined;
}

/** The keyboard's frame, or `undefined` when none shows. */
export function keyboardFrame(snapshot: Snapshot): Rect | undefined {
	return keyboardElement(snapshot)?.frame;
}
