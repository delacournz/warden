/** Overlay state machine for one pointer press: down, drag (sticky), release, then removed. */

export const DRAG_THRESHOLD_PX = 8;
export const RELEASE_REMOVE_MS = 180;

export type TouchPhase = "down" | "drag" | "release";
export type TouchState = {
	id: number;
	startX: number;
	startY: number;
	currentX: number;
	currentY: number;
	phase: TouchPhase;
};
export type TouchOverlay = TouchState | null;

export const idleTouch: TouchOverlay = null;

/** A new press. `lastId` keeps ids increasing after the previous overlay was removed. */
export function pressTouch(previous: TouchOverlay, x: number, y: number, lastId = 0): TouchState {
	const id = Math.max(previous?.id ?? 0, lastId) + 1;
	return { id, startX: x, startY: y, currentX: x, currentY: y, phase: "down" };
}

export function moveTouch(state: TouchOverlay, x: number, y: number): TouchOverlay {
	if (!state || state.phase === "release") return state;
	const phase: TouchPhase =
		state.phase === "drag" || Math.hypot(x - state.startX, y - state.startY) >= DRAG_THRESHOLD_PX ? "drag" : "down";
	return { ...state, currentX: x, currentY: y, phase };
}

export function releaseTouch(state: TouchOverlay): TouchOverlay {
	return state ? { ...state, phase: "release" } : state;
}

/** Drop the overlay once its release fade is over, unless a newer press replaced it. */
export function removeTouch(state: TouchOverlay, id: number): TouchOverlay {
	return state && state.id === id && state.phase === "release" ? null : state;
}
