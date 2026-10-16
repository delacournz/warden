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
	const options = { durationMs: preset.durationMs, momentum: preset.momentum };
	return { ...contentPath(direction, rect, preset.fraction), options };
}

/**
 * The one swipe geometry: the finger path inside `rect`, centred, covering `fraction` (0-1) of it, that scrolls the
 * content `direction` (`down` reveals what is below, so the finger travels up). Spec swipes, flow `swipe`/`scroll` steps
 * and `warden ui scroll` use it as is; `warden ui swipe <dir>` names the finger's direction instead and flips it
 * (`fingerPath` in the CLI).
 */
export function contentPath(direction: SwipeDirection, rect: Rect, fraction: number): { from: Point; to: Point } {
	const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	const halfX = (rect.width * fraction) / 2;
	const halfY = (rect.height * fraction) / 2;
	switch (direction) {
		case "down":
			return { from: { x: centre.x, y: centre.y + halfY }, to: { x: centre.x, y: centre.y - halfY } };
		case "up":
			return { from: { x: centre.x, y: centre.y - halfY }, to: { x: centre.x, y: centre.y + halfY } };
		case "right":
			return { from: { x: centre.x + halfX, y: centre.y }, to: { x: centre.x - halfX, y: centre.y } };
		case "left":
			return { from: { x: centre.x - halfX, y: centre.y }, to: { x: centre.x + halfX, y: centre.y } };
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

/** What a secure field shows for each character it holds: `•` (U+2022, iOS and Android) or `●` (U+25CF). */
const SECURE_DOTS: ReadonlySet<string> = new Set(["\u2022", "\u25cf"]);

/** The bullets in a secure field's value. Any other text it shows (iOS puts the placeholder there when empty) is not content. */
function countDots(value: string): number {
	let count = 0;
	for (const part of segmenter.segment(value)) if (SECURE_DOTS.has(part.segment)) count += 1;
	return count;
}

/** What one read says a field holds: nothing, text, or (secure fields) a number of hidden characters. */
export type FieldContent = { kind: "empty" } | { kind: "text"; text: string } | { kind: "dots"; count: number };

/**
 * What `entry` holds, for deciding how to empty it. A placeholder the element names is `empty` (see `fieldValue`),
 * and so is a secure field showing anything but dots. iOS reports `placeholder: null` for React Native inputs, so a
 * plain field showing its placeholder cannot be told from one holding that text and reads as `text`.
 */
export function fieldContent(entry: NodeEntry): FieldContent {
	if (entry.secure) {
		const count = countDots(entry.element.value ?? "");
		return count === 0 ? { kind: "empty" } : { kind: "dots", count };
	}
	const text = fieldValue(entry);
	return text === "" ? { kind: "empty" } : { kind: "text", text };
}

/**
 * Backspaces that empty a field once the caret is at its end: one per character plus a spare. Secure fields are
 * counted by their dots. The fallback for a driver without select-all, and the retry when select-all did not empty
 * the field.
 */
export function clearKeyPresses(entry: NodeEntry): number {
	const content = fieldContent(entry);
	switch (content.kind) {
		case "empty":
			return 0;
		case "text":
			return Math.min(graphemes(content.text) + 1, MAX_CLEAR_KEYS);
		case "dots":
			return Math.min(content.count + 1, MAX_CLEAR_KEYS);
	}
}
