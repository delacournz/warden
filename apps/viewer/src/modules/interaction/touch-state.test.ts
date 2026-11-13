import { describe, expect, test } from "bun:test";
import {
	DRAG_THRESHOLD_PX,
	idleTouch,
	moveTouch,
	pressTouch,
	releaseTouch,
	removeTouch,
	type TouchState,
} from "./touch-state.ts";

describe("touch overlay state", () => {
	test("idle is empty", () => {
		expect(idleTouch).toBeNull();
	});

	test("a press starts in down phase and increments the id", () => {
		const first = pressTouch(null, 10, 20);
		expect(first).toEqual({ id: 1, startX: 10, startY: 20, currentX: 10, currentY: 20, phase: "down" });
		const second = pressTouch(releaseTouch(first), 0, 0);
		expect(second.id).toBe(2);
	});

	test("ids keep growing after the overlay was removed", () => {
		const first = pressTouch(null, 0, 0);
		expect(pressTouch(null, 0, 0, first.id).id).toBe(2);
	});

	test("small moves stay down, then phase goes to drag at the threshold and stays", () => {
		let state: TouchState = pressTouch(null, 0, 0);
		state = moveTouch(state, DRAG_THRESHOLD_PX - 1, 0) as TouchState;
		expect(state.phase).toBe("down");
		state = moveTouch(state, DRAG_THRESHOLD_PX, 0) as TouchState;
		expect(state.phase).toBe("drag");
		state = moveTouch(state, 1, 0) as TouchState;
		expect(state.phase).toBe("drag");
		expect(state.currentX).toBe(1);
	});

	test("release sets the phase and removal only matches the same id", () => {
		const pressed = pressTouch(null, 0, 0);
		const released = releaseTouch(pressed);
		expect(released?.phase).toBe("release");
		expect(removeTouch(released, pressed.id + 1)).toEqual(released);
		expect(removeTouch(released, pressed.id)).toBeNull();
	});

	test("moves and releases on nothing are no-ops", () => {
		expect(moveTouch(null, 1, 1)).toBeNull();
		expect(releaseTouch(null)).toBeNull();
	});

	test("a move after release is ignored", () => {
		const released = releaseTouch(pressTouch(null, 0, 0));
		expect(moveTouch(released, 50, 50)).toEqual(released);
	});
});
