import type { Point, Rect, ScreenInfo } from "../driver/driver.types";
import type { NodeEntry } from "./nodes";

/** Pure helpers behind the locator actions: where to tap, how to swipe, how to empty a field. No driver calls. */

/** The way the content scrolls: `down` reveals what is below, so the finger moves up. */
export type SwipeDirection = "up" | "down" | "left" | "right";

/** Fling strength of a swipe: `none` is a plain drag of half the surface. */
export type Momentum = "none" | "slow" | "fast";

export type SwipeVector = {
	from: Point;
	to: Point;
	options: { durationMs: number; momentum: boolean };
};

const MOMENTUM: Record<Momentum, { fraction: number; durationMs: number; momentum: boolean }> = {
	none: { fraction: 0.5, durationMs: 350, momentum: false },
	slow: { fraction: 0.5, durationMs: 200, momentum: true },
	fast: { fraction: 0.7, durationMs: 120, momentum: true },
};

/** Share of a field's width, from its left edge, where a tap puts the caret after the text. */
const FOCUS_X = 0.9;
/** Never press more keys than this to empty a field. */
const MAX_CLEAR_KEYS = 300;

/** Where a tap on `entry` lands: `position` is an offset from its top-left corner, else the driver's tap point or the centre. */
export function tapPointOf(entry: NodeEntry, position?: Point): Point {
	const { frame, tapPoint } = entry.element;
	if (position !== undefined) return { x: frame.x + position.x, y: frame.y + position.y };
	return tapPoint ?? { x: frame.x + frame.width / 2, y: frame.y + frame.height / 2 };
}

/** A tap here focuses a text field with the caret after its text (right of where the text ends). */
export function focusPoint(frame: Rect): Point {
	return { x: frame.x + frame.width * FOCUS_X, y: frame.y + frame.height / 2 };
}

/** The finger path that scrolls `rect`'s content in `direction`, centred on the rect. */
export function swipeVector(direction: SwipeDirection, rect: Rect, momentum: Momentum = "none"): SwipeVector {
	const preset = MOMENTUM[momentum];
	const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	const halfX = (rect.width * preset.fraction) / 2;
	const halfY = (rect.height * preset.fraction) / 2;
	const options = { durationMs: preset.durationMs, momentum: preset.momentum };
	switch (direction) {
		case "down":
			return { from: { x: centre.x, y: centre.y + halfY }, to: { x: centre.x, y: centre.y - halfY }, options };
		case "up":
			return { from: { x: centre.x, y: centre.y - halfY }, to: { x: centre.x, y: centre.y + halfY }, options };
		case "right":
			return { from: { x: centre.x + halfX, y: centre.y }, to: { x: centre.x - halfX, y: centre.y }, options };
		case "left":
			return { from: { x: centre.x - halfX, y: centre.y }, to: { x: centre.x + halfX, y: centre.y }, options };
	}
}

export function screenRect(screen: ScreenInfo): Rect {
	return { x: 0, y: 0, width: screen.width, height: screen.height };
}

/** The part of `frame` that is on the screen (the whole frame when the screen size is unknown). */
export function visibleRect(frame: Rect, screen: ScreenInfo): Rect {
	if (screen.width <= 0 || screen.height <= 0) return frame;
	const left = Math.max(frame.x, 0);
	const top = Math.max(frame.y, 0);
	const right = Math.min(frame.x + frame.width, screen.width);
	const bottom = Math.min(frame.y + frame.height, screen.height);
	return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** Whether a point is on the screen (an unknown screen size accepts everything). */
export function isOnScreen(point: Point, screen: ScreenInfo): boolean {
	if (screen.width <= 0 || screen.height <= 0) return true;
	return point.x >= 0 && point.y >= 0 && point.x <= screen.width && point.y <= screen.height;
}

/**
 * What a text field holds. Secure fields hold nothing readable; iOS reports the placeholder as the value of an empty
 * field; Android keeps an input's text in `text`.
 */
export function fieldValue(entry: NodeEntry): string {
	if (entry.secure) return "";
	const { element } = entry;
	const own = entry.value ?? (entry.role === "textbox" || entry.role === "searchbox" ? element.text : undefined);
	if (own === undefined || own === "") return "";
	if (element.placeholder !== undefined && own === element.placeholder && entry.states.focused !== true) return "";
	return own;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemes(text: string): number {
	let count = 0;
	for (const _ of segmenter.segment(text)) count += 1;
	return count;
}

/**
 * Backspaces that empty a field once the caret is at its end: one per character plus a spare. Secure fields are
 * counted by their dots. The driver contract has no select-all, so clearing is backspaces.
 */
export function clearKeyPresses(entry: NodeEntry): number {
	const text = entry.secure ? (entry.element.value ?? "") : fieldValue(entry);
	if (text === "") return 0;
	return Math.min(graphemes(text) + 1, MAX_CLEAR_KEYS);
}
