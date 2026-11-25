import { describe, expect, test } from "bun:test";
import { createActions, type DeviceAction } from "./device-actions.ts";
import { classifyRelease, createMultiTouchSession, createTouchSession } from "./touch-session.ts";

function recorder() {
	const log: DeviceAction[] = [];
	return { log, actions: createActions((a) => log.push(a)) };
}

describe("classifyRelease", () => {
	test("tap when short and still", () => {
		expect(classifyRelease({ travelPx: 3, durationMs: 100 })).toBe("tap");
	});
	test("long_press when still and held 500 ms or more", () => {
		expect(classifyRelease({ travelPx: 3, durationMs: 500 })).toBe("long_press");
		expect(classifyRelease({ travelPx: 3, durationMs: 499 })).toBe("tap");
	});
	test("drag at 12 px or more regardless of time", () => {
		expect(classifyRelease({ travelPx: 12, durationMs: 900 })).toBe("drag");
		expect(classifyRelease({ travelPx: 11.9, durationMs: 10 })).toBe("tap");
	});
});

describe("touch session", () => {
	test("down, throttled moves, final move, then up with a tap", () => {
		const { log, actions } = recorder();
		const session = createTouchSession(actions);
		session.down({ x: 10, y: 10 }, { x: 5, y: 5 }, 0);
		session.move({ x: 11, y: 10 }, { x: 6, y: 5 }, 2);
		session.move({ x: 12, y: 10 }, { x: 7, y: 5 }, 9);
		const gesture = session.up({ x: 12, y: 10 }, { x: 7, y: 5 }, 100);
		expect(gesture).toBe("tap");
		expect(log.map((a) => a.kind)).toEqual(["touchDown", "touchMove", "touchMove", "touchUp"]);
		expect(log[1]).toEqual({ kind: "touchMove", x: 12, y: 10 });
		expect(log[3]).toEqual({ kind: "touchUp", x: 12, y: 10, durationMs: 100, gesture: "tap" });
	});

	test("moves closer than 8 ms to the last sent are dropped", () => {
		const { log, actions } = recorder();
		const session = createTouchSession(actions);
		session.down({ x: 0, y: 0 }, { x: 0, y: 0 }, 0);
		session.move({ x: 1, y: 0 }, { x: 1, y: 0 }, 8);
		session.move({ x: 2, y: 0 }, { x: 2, y: 0 }, 12);
		session.move({ x: 3, y: 0 }, { x: 3, y: 0 }, 16);
		expect(log.filter((a) => a.kind === "touchMove")).toHaveLength(2);
	});

	test("max travel decides drag even if the pointer returns", () => {
		const { log, actions } = recorder();
		const session = createTouchSession(actions);
		session.down({ x: 0, y: 0 }, { x: 0, y: 0 }, 0);
		session.move({ x: 5, y: 0 }, { x: 30, y: 0 }, 20);
		expect(session.up({ x: 0, y: 0 }, { x: 0, y: 0 }, 60)).toBe("drag");
		expect(log.at(-1)).toMatchObject({ kind: "touchUp", gesture: "drag" });
	});

	test("up without a down does nothing", () => {
		const { log, actions } = recorder();
		expect(createTouchSession(actions).up({ x: 0, y: 0 }, { x: 0, y: 0 }, 5)).toBeNull();
		expect(log).toHaveLength(0);
	});
});

describe("multi-touch session", () => {
	const two = (a: number, b: number) => [
		{ id: 1, x: a, y: a },
		{ id: 2, x: b, y: b },
	];

	test("zoom_in when fingers end further from the centre", () => {
		const { log, actions } = recorder();
		const session = createMultiTouchSession(actions);
		session.down(two(10, 20), 20, 0);
		session.move(two(5, 25), 40, 10);
		expect(session.up(two(0, 30), 60)).toBe("zoom_in");
		expect(log.map((a) => a.kind)).toEqual(["multiTouchDown", "multiTouchMove", "multiTouchUp"]);
		expect(log[2]).toEqual({ kind: "multiTouchUp", touches: two(0, 30), gesture: "zoom_in" });
	});

	test("zoom_out when fingers end closer", () => {
		const { actions } = recorder();
		const session = createMultiTouchSession(actions);
		session.down(two(0, 30), 60, 0);
		expect(session.up(two(10, 20), 20)).toBe("zoom_out");
	});

	test("multi moves are throttled too", () => {
		const { log, actions } = recorder();
		const session = createMultiTouchSession(actions);
		session.down(two(0, 30), 60, 0);
		session.move(two(1, 29), 58, 2);
		session.move(two(2, 28), 56, 9);
		expect(log.filter((a) => a.kind === "multiTouchMove")).toHaveLength(1);
	});
});
