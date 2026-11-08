import type { Driver, DriverResult, Point, Rect, Snapshot } from "../driver/driver.types";
import { keyboardFrame } from "../driver/keyboard-state";
import type { NodeEntry } from "./nodes";

/**
 * A target under the on-screen keyboard (the default `software` mode keeps it up) cannot be tapped: the touch lands on
 * a key. Before a tap or long press the locator asks {@link coverOf}; a covered target in a scroll container is scrolled
 * into the free part of the screen, any other is reached by dismissing the keyboard.
 */

/** Space left between a scrolled target and the keyboard's top edge, in points. */
const COVER_MARGIN = 40;
/** Never start or end a scroll swipe closer than this to the edge of the container's free part. */
const SWIPE_INSET = 12;
/** The finger path of a scroll swipe: a drag, so the content follows it one to one. */
const SCROLL_SWIPE = { durationMs: 350, momentum: false };

export type Cover = {
	/** the keyboard's top edge */
	top: number;
	/** the free part of the nearest scroll container (its frame down to the keyboard), when the target sits in one */
	scroller?: Rect;
	/** points the content has to move up to clear the keyboard with a margin */
	shift: number;
};

const SCROLL_ROLES: ReadonlySet<string> = new Set(["scrollview", "list"]);

function scrollContainer(entry: NodeEntry): NodeEntry | undefined {
	for (let node = entry.parent; node !== undefined; node = node.parent) {
		if (SCROLL_ROLES.has(node.element.role)) return node;
	}
	return undefined;
}

/** Whether `point` is under the keyboard of `snapshot`, and how to get clear of it; undefined when it is not. */
export function coverOf(entry: NodeEntry, point: Point, snapshot: Snapshot): Cover | undefined {
	const keyboard = keyboardFrame(snapshot);
	if (keyboard === undefined || entry.element.role === "keyboard") return undefined;
	const inside =
		point.x >= keyboard.x &&
		point.x <= keyboard.x + keyboard.width &&
		point.y >= keyboard.y &&
		point.y <= keyboard.y + keyboard.height;
	if (!inside) return undefined;
	const container = scrollContainer(entry);
	const shift = point.y - (keyboard.y - COVER_MARGIN);
	if (container === undefined) return { top: keyboard.y, shift };
	const { frame } = container.element;
	const bottom = Math.min(frame.y + frame.height, keyboard.y);
	const free = { x: frame.x, y: frame.y, width: frame.width, height: Math.max(0, bottom - frame.y) };
	return free.height > 2 * SWIPE_INSET ? { top: keyboard.y, scroller: free, shift } : { top: keyboard.y, shift };
}

/**
 * The finger path that moves the content of `scroller` up by about `shift` points (a shorter one when the free part
 * is not that tall: the caller looks again and swipes again).
 */
export function scrollPath(scroller: Rect, shift: number): { from: Point; to: Point } {
	const x = scroller.x + scroller.width / 2;
	const room = scroller.height - 2 * SWIPE_INSET;
	const travel = Math.max(1, Math.min(shift, room));
	const from = scroller.y + scroller.height - SWIPE_INSET;
	return { from: { x, y: from }, to: { x, y: from - travel } };
}

export const COVER_SCROLL_SWIPE = SCROLL_SWIPE;

/** Dismisses the keyboard the way `device.hideKeyboard()` does: iOS resigns the first responder (no Return), Android presses back. */
export async function dismissKeyboard(driver: Driver): DriverResult<void> {
	const done = await driver.dismissKeyboard();
	return done.success ? { success: true, data: undefined } : done;
}
