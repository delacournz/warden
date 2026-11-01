import { describe, expect, test } from "bun:test";
import type { Point, TouchPath } from "./driver.types";
import {
	DEFAULT_GESTURE_MS,
	GESTURE_FRAME_MS,
	GESTURE_MAX_FRAMES,
	GESTURE_MAX_MS,
	type GesturePlan,
	pinchPlan,
	planGesture,
	rotatePlan,
	twoFingerPaths,
} from "./gesture-geometry";

const path = (...points: (Point & { t?: number })[]): TouchPath => ({ points });

function planned(result: ReturnType<typeof planGesture>): GesturePlan {
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.data;
}

function failure(result: ReturnType<typeof planGesture>): string {
	if (result.success) throw new Error("expected a failure");
	return result.error.code;
}

function distance(a: Point, b: Point): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("planGesture", () => {
	test("an untimed path spreads durationMs by arc length onto ~16 ms frames", () => {
		const plan = planned(
			planGesture([path({ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 })], { durationMs: 320 }, 2)
		);
		expect(plan.paths).toHaveLength(1);
		const frames = plan.paths[0] ?? [];
		expect(frames).toHaveLength(21);
		expect(plan.frameMs).toBeCloseTo(16, 5);
		expect(plan.totalMs).toBeCloseTo(320, 5);
		expect(frames[0]).toEqual({ x: 0, y: 0 });
		expect(frames[10]).toEqual({ x: 100, y: 0 });
		expect(frames[20]).toEqual({ x: 100, y: 100 });
		expect(frames[5]).toEqual({ x: 50, y: 0 });
	});

	test("default duration and no hold or release", () => {
		const plan = planned(planGesture([path({ x: 0, y: 0 }, { x: 10, y: 0 })], undefined, 1));
		expect(plan.totalMs).toBeCloseTo(DEFAULT_GESTURE_MS, 5);
		expect(plan.holdMs).toBe(0);
		expect(plan.releaseMs).toBe(0);
	});

	test("hold and release are added to the total", () => {
		const plan = planned(
			planGesture([path({ x: 0, y: 0 }, { x: 10, y: 0 })], { durationMs: 160, holdMs: 100, releaseMs: 50 }, 1)
		);
		expect(plan.holdMs).toBe(100);
		expect(plan.releaseMs).toBe(50);
		expect(plan.totalMs).toBeCloseTo(310, 5);
	});

	test("the last frame lands exactly on the end even when the duration is not a multiple of 16", () => {
		const plan = planned(planGesture([path({ x: 0, y: 0 }, { x: 33, y: 0 })], { durationMs: 100 }, 1));
		const frames = plan.paths[0] ?? [];
		expect(frames).toHaveLength(Math.ceil(100 / GESTURE_FRAME_MS) + 1);
		expect(frames.at(-1)).toEqual({ x: 33, y: 0 });
		expect(plan.frameMs * (frames.length - 1)).toBeCloseTo(100, 5);
	});

	test("timed points are followed as given", () => {
		const plan = planned(
			planGesture(
				[path({ x: 0, y: 0, t: 0 }, { x: 10, y: 0, t: 32 }, { x: 10, y: 0, t: 160 }, { x: 20, y: 0, t: 192 })],
				undefined,
				1
			)
		);
		const frames = plan.paths[0] ?? [];
		expect(plan.totalMs).toBeCloseTo(192, 5);
		expect(frames[1]).toEqual({ x: 5, y: 0 });
		expect(frames[2]).toEqual({ x: 10, y: 0 });
		expect(frames[6]).toEqual({ x: 10, y: 0 });
		expect(frames.at(-1)).toEqual({ x: 20, y: 0 });
	});

	test("two fingers share one timeline; the shorter one holds its last point", () => {
		const plan = planned(
			planGesture(
				[path({ x: 0, y: 0, t: 0 }, { x: 100, y: 0, t: 160 }), path({ x: 0, y: 50, t: 0 }, { x: 0, y: 150, t: 80 })],
				undefined,
				2
			)
		);
		const [a, b] = plan.paths;
		expect(a).toHaveLength(11);
		expect(b).toHaveLength(11);
		expect(b?.[5]).toEqual({ x: 0, y: 150 });
		expect(b?.[10]).toEqual({ x: 0, y: 150 });
		expect(a?.[10]).toEqual({ x: 100, y: 0 });
	});

	test("untimed fingers each move at their own constant speed over the same duration", () => {
		const plan = planned(
			planGesture(
				[path({ x: 0, y: 0 }, { x: 100, y: 0 }), path({ x: 0, y: 10 }, { x: 10, y: 10 })],
				{ durationMs: 160 },
				2
			)
		);
		expect(plan.paths[0]?.[5]).toEqual({ x: 50, y: 0 });
		expect(plan.paths[1]?.[5]).toEqual({ x: 5, y: 10 });
	});

	test("a single point is a stationary finger: one frame, a tap", () => {
		const plan = planned(planGesture([path({ x: 7, y: 9 })], undefined, 1));
		expect(plan.paths).toEqual([[{ x: 7, y: 9 }]]);
		expect(plan.totalMs).toBe(0);
	});

	test("a zero-length untimed path held for its duration", () => {
		const plan = planned(planGesture([path({ x: 7, y: 9 }, { x: 7, y: 9 })], { durationMs: 32 }, 1));
		expect(plan.paths[0]).toEqual([
			{ x: 7, y: 9 },
			{ x: 7, y: 9 },
			{ x: 7, y: 9 },
		]);
	});

	test("coordinates are rounded to 0.01", () => {
		const plan = planned(planGesture([path({ x: 0, y: 0 }, { x: 1, y: 0 })], { durationMs: 48 }, 1));
		expect(plan.paths[0]?.[1]).toEqual({ x: 0.33, y: 0 });
	});

	test("long gestures are capped at GESTURE_MAX_FRAMES + 1 frames", () => {
		const plan = planned(planGesture([path({ x: 0, y: 0 }, { x: 10, y: 0 })], { durationMs: GESTURE_MAX_MS }, 1));
		expect(plan.paths[0]).toHaveLength(GESTURE_MAX_FRAMES + 1);
		expect(plan.frameMs).toBeCloseTo(60, 5);
	});

	test("bad input is E_BAD_REQUEST", () => {
		const one = path({ x: 0, y: 0 }, { x: 1, y: 1 });
		expect(failure(planGesture([], undefined, 2))).toBe("E_BAD_REQUEST");
		expect(failure(planGesture([one, one, one], undefined, 2))).toBe("E_BAD_REQUEST");
		expect(failure(planGesture([path()], undefined, 2))).toBe("E_BAD_REQUEST");
		expect(failure(planGesture([path({ x: Number.NaN, y: 0 })], undefined, 2))).toBe("E_BAD_REQUEST");
		expect(failure(planGesture([path({ x: 0, y: 0, t: 0 }, { x: 1, y: 0 })], undefined, 2))).toBe("E_BAD_REQUEST");
		expect(failure(planGesture([path({ x: 0, y: 0, t: 0 }, { x: 1, y: 0, t: 10 })], { durationMs: 10 }, 2))).toBe(
			"E_BAD_REQUEST"
		);
		expect(failure(planGesture([path({ x: 0, y: 0, t: 5 }, { x: 1, y: 0, t: 10 })], undefined, 2))).toBe(
			"E_BAD_REQUEST"
		);
		expect(
			failure(planGesture([path({ x: 0, y: 0, t: 0 }, { x: 1, y: 0, t: 10 }, { x: 2, y: 0, t: 5 })], undefined, 2))
		).toBe("E_BAD_REQUEST");
		expect(failure(planGesture([one], { durationMs: -1 }, 2))).toBe("E_BAD_REQUEST");
		expect(failure(planGesture([one], { holdMs: -1 }, 2))).toBe("E_BAD_REQUEST");
		expect(failure(planGesture([one], { durationMs: GESTURE_MAX_MS, releaseMs: 1 }, 2))).toBe("E_BAD_REQUEST");
	});

	test("more fingers than the driver takes is E_UNSUPPORTED", () => {
		const one = path({ x: 0, y: 0 }, { x: 1, y: 1 });
		expect(failure(planGesture([one, one], undefined, 1))).toBe("E_UNSUPPORTED");
		expect(failure(planGesture([one], undefined, 0))).toBe("E_UNSUPPORTED");
	});
});

describe("twoFingerPaths", () => {
	test("a pure pinch is two straight lines along the axis", () => {
		const [a, b] = twoFingerPaths({ x: 200, y: 400 }, { radius: 100, scale: 0.5 }, 400);
		expect(a.points).toEqual([
			{ x: 100, y: 400, t: 0 },
			{ x: 150, y: 400, t: 400 },
		]);
		expect(b.points).toEqual([
			{ x: 300, y: 400, t: 0 },
			{ x: 250, y: 400, t: 400 },
		]);
	});

	test("angle turns the finger axis (degrees, clockwise in screen space)", () => {
		const [a, b] = twoFingerPaths({ x: 0, y: 0 }, { radius: 10, scale: 2, angle: 90 }, 200);
		expect(a.points[0]?.x).toBeCloseTo(0, 5);
		expect(a.points[0]?.y).toBeCloseTo(-10, 5);
		expect(b.points[0]?.y).toBeCloseTo(10, 5);
		expect(b.points.at(-1)?.y).toBeCloseTo(20, 5);
	});

	test("a rotation follows an arc around the centre, clockwise for positive degrees", () => {
		const [a, b] = twoFingerPaths({ x: 200, y: 400 }, { radius: 100, degrees: 90 }, 500);
		expect(b.points[0]).toMatchObject({ x: 300, y: 400 });
		expect(b.points.at(-1)?.x).toBeCloseTo(200, 5);
		expect(b.points.at(-1)?.y).toBeCloseTo(500, 5);
		expect(a.points.at(-1)?.y).toBeCloseTo(300, 5);
		expect(b.points.length).toBeGreaterThan(10);
		for (const point of b.points) expect(distance(point, { x: 200, y: 400 })).toBeCloseTo(100, 5);
		expect(b.points.at(-1)?.t).toBe(500);
	});
});

describe("pinchPlan / rotatePlan", () => {
	test("pinch uses the default radius, its own default duration and a short still release", () => {
		const plan = pinchPlan({ x: 200, y: 400 }, 0.5, undefined, 100);
		if (!plan.success) throw new Error(plan.error.message);
		expect(plan.data.paths).toHaveLength(2);
		expect(plan.data.paths[0]?.[0]).toEqual({ x: 100, y: 400 });
		expect(plan.data.paths[0]?.at(-1)).toEqual({ x: 150, y: 400 });
		expect(plan.data.releaseMs).toBeGreaterThan(0);
	});

	test("pinch honours radius and durationMs", () => {
		const plan = pinchPlan({ x: 0, y: 0 }, 2, { radius: 10, durationMs: 160 }, 100);
		if (!plan.success) throw new Error(plan.error.message);
		expect(plan.data.paths[1]?.[0]).toEqual({ x: 10, y: 0 });
		expect(plan.data.paths[1]?.at(-1)).toEqual({ x: 20, y: 0 });
		expect(plan.data.paths[1]).toHaveLength(11);
	});

	test("rotate ends a quarter turn round", () => {
		const plan = rotatePlan({ x: 200, y: 400 }, 90, { radius: 100 }, 50);
		if (!plan.success) throw new Error(plan.error.message);
		expect(plan.data.paths[1]?.at(-1)).toEqual({ x: 200, y: 500 });
		expect(plan.data.paths[0]?.at(-1)).toEqual({ x: 200, y: 300 });
	});

	test("bad amounts are E_BAD_REQUEST", () => {
		const codes = [
			pinchPlan({ x: 0, y: 0 }, 0, undefined, 100),
			pinchPlan({ x: 0, y: 0 }, Number.POSITIVE_INFINITY, undefined, 100),
			pinchPlan({ x: 0, y: 0 }, 2, { radius: 0 }, 100),
			rotatePlan({ x: 0, y: 0 }, Number.NaN, undefined, 100),
			rotatePlan({ x: Number.NaN, y: 0 }, 45, undefined, 100),
		].map((result) => (result.success ? "ok" : result.error.code));
		expect(codes).toEqual(["E_BAD_REQUEST", "E_BAD_REQUEST", "E_BAD_REQUEST", "E_BAD_REQUEST", "E_BAD_REQUEST"]);
	});
});
