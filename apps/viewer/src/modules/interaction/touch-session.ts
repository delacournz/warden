import type { DeviceActions, FingerTouch, PinchScale, TouchGesture } from "./device-actions.ts";
import type { Point } from "./geometry.ts";
import { zoomDirection } from "./geometry.ts";

export const MOVE_THROTTLE_MS = 8;
export const DRAG_DISTANCE_PX = 12;
export const LONG_PRESS_MS = 500;

/** Drag at 12 CSS px of travel or more, else a hold of 500 ms or more is a long press, else a tap. */
export function classifyRelease(input: { travelPx: number; durationMs: number }): TouchGesture {
	if (input.travelPx >= DRAG_DISTANCE_PX) return "drag";
	return input.durationMs >= LONG_PRESS_MS ? "long_press" : "tap";
}

export type TouchSession = {
	down: (device: Point, client: Point, t: number) => void;
	move: (device: Point, client: Point, t: number) => void;
	up: (device: Point, client: Point, t: number) => TouchGesture | null;
};

/**
 * One single-finger press. Sends touchDown, throttled touchMove (visuals are not throttled, only
 * the device calls), one final touchMove at the release position, then touchUp with the gesture.
 * Travel is the farthest the pointer got from the press, so a drag that returns is still a drag.
 */
export function createTouchSession(actions: DeviceActions): TouchSession {
	let start: { client: Point; t: number } | null = null;
	let lastSent = Number.NEGATIVE_INFINITY;
	let travel = 0;

	return {
		down(device, client, t) {
			start = { client, t };
			lastSent = t;
			travel = 0;
			actions.touchDown(device);
		},
		move(device, client, t) {
			if (!start) return;
			travel = Math.max(travel, Math.hypot(client.x - start.client.x, client.y - start.client.y));
			if (t - lastSent < MOVE_THROTTLE_MS) return;
			lastSent = t;
			actions.touchMove(device);
		},
		up(device, client, t) {
			if (!start) return null;
			travel = Math.max(travel, Math.hypot(client.x - start.client.x, client.y - start.client.y));
			const durationMs = Math.max(0, Math.round(t - start.t));
			const gesture = classifyRelease({ travelPx: travel, durationMs });
			start = null;
			actions.touchMove(device);
			actions.touchUp({ x: device.x, y: device.y, durationMs, gesture });
			return gesture;
		},
	};
}

export type MultiTouchSession = {
	down: (touches: FingerTouch[], centreDistance: number, t: number) => void;
	move: (touches: FingerTouch[], centreDistance: number, t: number) => void;
	up: (touches: FingerTouch[], centreDistance: number) => PinchScale | null;
};

/** The Alt two-finger press: throttled moves, and on release zoom_in or zoom_out by centre distance. */
export function createMultiTouchSession(actions: DeviceActions): MultiTouchSession {
	let startDistance: number | null = null;
	let lastSent = Number.NEGATIVE_INFINITY;

	return {
		down(touches, centreDistance, t) {
			startDistance = centreDistance;
			lastSent = t;
			actions.multiTouchDown({ touches });
		},
		move(touches, _centreDistance, t) {
			if (startDistance === null || t - lastSent < MOVE_THROTTLE_MS) return;
			lastSent = t;
			actions.multiTouchMove({ touches });
		},
		up(touches, centreDistance) {
			if (startDistance === null) return null;
			const gesture = zoomDirection(startDistance, centreDistance);
			startDistance = null;
			actions.multiTouchUp({ touches, gesture });
			return gesture;
		},
	};
}
