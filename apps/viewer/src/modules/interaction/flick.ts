import type { SwipeDirection } from "./device-actions.ts";
import type { Point } from "./geometry.ts";

export const FLICK_MAX_MS = 250;
export const FLICK_MIN_POINTS = 40;

export type FlickResult = { kind: "swipe"; direction: SwipeDirection } | { kind: "drag" };

/**
 * A release faster than 250 ms that travelled 40 device points or more is a flick, sent as a
 * swipe in the dominant axis direction; anything slower or shorter is a drag along the real path.
 */
export function classifyFlick(input: { from: Point; to: Point; durationMs: number }): FlickResult {
	const dx = input.to.x - input.from.x;
	const dy = input.to.y - input.from.y;
	if (input.durationMs >= FLICK_MAX_MS || Math.hypot(dx, dy) < FLICK_MIN_POINTS) return { kind: "drag" };
	if (Math.abs(dx) > Math.abs(dy)) return { kind: "swipe", direction: dx > 0 ? "right" : "left" };
	return { kind: "swipe", direction: dy > 0 ? "down" : "up" };
}
