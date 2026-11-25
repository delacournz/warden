import { describe, expect, test } from "bun:test";
import { fakeDriver, snapshotOf } from "./driver.testing";
import type { Driver, DriverResult, Point } from "./driver.types";
import {
	applyTouchOps,
	canLiveTouch,
	type LiveTouch,
	type TouchOp,
	type TouchPointer,
	type TouchScreen,
	viewerFrameToTouch,
} from "./live-touch";

const portrait: TouchScreen = { width: 390, height: 844, scale: 1, rotation: 0 };

describe("viewerFrameToTouch", () => {
	test("a one-finger touch frame is one op on pointer 0", () => {
		for (const phase of ["down", "move", "up"] as const) {
			expect(viewerFrameToTouch({ type: "touch", phase, x: 10, y: 20 }, portrait)).toEqual({
				kind: "touch",
				ops: [{ op: phase, point: { x: 10, y: 20 }, pointer: 0 }],
			});
		}
	});

	test("ids, durations and gesture labels on the frame are ignored", () => {
		const frame = { type: "touch", id: "7", phase: "up", x: 5, y: 6, durationMs: 120, gesture: "tap" };
		expect(viewerFrameToTouch(frame, portrait)).toEqual({
			kind: "touch",
			ops: [{ op: "up", point: { x: 5, y: 6 }, pointer: 0 }],
		});
	});

	test("a two-finger frame is one op per finger, pointers by ascending touch id", () => {
		const frame = {
			type: "multiTouch",
			phase: "move",
			touches: [
				{ id: 9, x: 300, y: 400 },
				{ id: 2, x: 100, y: 200 },
			],
		};
		expect(viewerFrameToTouch(frame, portrait)).toEqual({
			kind: "touch",
			ops: [
				{ op: "move", point: { x: 100, y: 200 }, pointer: 0 },
				{ op: "move", point: { x: 300, y: 400 }, pointer: 1 },
			],
		});
	});

	test("a two-finger lift lifts the second pointer first", () => {
		const frame = {
			type: "multiTouch",
			phase: "up",
			touches: [
				{ id: 1, x: 1, y: 2 },
				{ id: 2, x: 3, y: 4 },
			],
		};
		const mapped = viewerFrameToTouch(frame, portrait);
		expect(mapped.kind === "touch" && mapped.ops.map((o) => (o.op === "cancel" ? -1 : o.pointer))).toEqual([1, 0]);
	});

	test("scale turns viewer points into driver units (Android pixels)", () => {
		const android: TouchScreen = { width: 411, height: 914, scale: 2.625, rotation: 0 };
		expect(viewerFrameToTouch({ type: "touch", phase: "down", x: 100, y: 200 }, android)).toEqual({
			kind: "touch",
			ops: [{ op: "down", point: { x: 262.5, y: 525 }, pointer: 0 }],
		});
	});

	test("points outside the picture are clamped onto its edge", () => {
		expect(viewerFrameToTouch({ type: "touch", phase: "move", x: -20, y: 900 }, portrait)).toEqual({
			kind: "touch",
			ops: [{ op: "move", point: { x: 0, y: 844 }, pointer: 0 }],
		});
	});

	test("a picture turned from the driver's space is turned back", () => {
		const corner = (rotation: TouchScreen["rotation"], x: number, y: number, width: number, height: number) => {
			const mapped = viewerFrameToTouch({ type: "touch", phase: "down", x, y }, { width, height, scale: 1, rotation });
			return mapped.kind === "touch" && mapped.ops[0]?.op === "down" ? mapped.ops[0].point : undefined;
		};
		expect(corner(0, 10, 20, 390, 844)).toEqual({ x: 10, y: 20 });
		expect(corner(90, 844, 0, 844, 390)).toEqual({ x: 0, y: 0 });
		expect(corner(90, 834, 10, 844, 390)).toEqual({ x: 10, y: 10 });
		expect(corner(180, 380, 834, 390, 844)).toEqual({ x: 10, y: 10 });
		expect(corner(270, 10, 380, 844, 390)).toEqual({ x: 10, y: 10 });
	});

	test("other viewer frames are passed through by type", () => {
		expect(viewerFrameToTouch({ type: "key", key: "enter" }, portrait)).toEqual({ kind: "other", type: "key" });
		expect(viewerFrameToTouch({ type: "goHome" }, portrait)).toEqual({ kind: "other", type: "goHome" });
	});

	test("malformed frames are invalid with a reason", () => {
		const bad: unknown[] = [
			null,
			"touch",
			{},
			{ type: 3 },
			{ type: "touch", phase: "hover", x: 1, y: 1 },
			{ type: "touch", phase: "down", x: Number.NaN, y: 1 },
			{ type: "touch", phase: "down", x: "1", y: 1 },
			{ type: "multiTouch", phase: "down", touches: [] },
			{
				type: "multiTouch",
				phase: "down",
				touches: [
					{ id: 1, x: 1, y: 1 },
					{ id: 2, x: 1, y: 1 },
					{ id: 3, x: 1, y: 1 },
				],
			},
			{ type: "multiTouch", phase: "down", touches: [{ id: 1, x: 1 }] },
			{
				type: "multiTouch",
				phase: "down",
				touches: [
					{ id: 1, x: 1, y: 1 },
					{ id: 1, x: 2, y: 2 },
				],
			},
		];
		for (const frame of bad) {
			const mapped = viewerFrameToTouch(frame, portrait);
			expect(mapped.kind).toBe("invalid");
			if (mapped.kind === "invalid") expect(mapped.reason.length).toBeGreaterThan(0);
		}
	});
});

type Call = { op: string; point?: Point; pointer?: TouchPointer };

function recorder(failAt?: number): LiveTouch & { calls: Call[] } {
	const calls: Call[] = [];
	const answer = (call: Call): DriverResult<void> => {
		calls.push(call);
		if (failAt !== undefined && calls.length === failAt) {
			return Promise.resolve({
				success: false,
				error: { code: "E_BAD_REQUEST", message: "pointer 0 is not down", retryable: false },
			});
		}
		return Promise.resolve({ success: true, data: undefined });
	};
	return {
		calls,
		touchDown: (point, pointer) => answer({ op: "down", point, pointer }),
		touchMove: (point, pointer) => answer({ op: "move", point, pointer }),
		touchUp: (point, pointer) => answer({ op: "up", point, pointer }),
		touchCancel: () => answer({ op: "cancel" }),
	};
}

describe("applyTouchOps", () => {
	const ops: TouchOp[] = [
		{ op: "down", point: { x: 1, y: 2 }, pointer: 0 },
		{ op: "down", point: { x: 3, y: 4 }, pointer: 1 },
		{ op: "cancel" },
	];

	test("sends the ops in order", async () => {
		const live = recorder();
		expect(await applyTouchOps(live, ops)).toEqual({ success: true, data: undefined });
		expect(live.calls).toEqual([
			{ op: "down", point: { x: 1, y: 2 }, pointer: 0 },
			{ op: "down", point: { x: 3, y: 4 }, pointer: 1 },
			{ op: "cancel" },
		]);
	});

	test("stops at the first failure and returns it", async () => {
		const live = recorder(1);
		const result = await applyTouchOps(live, ops);
		expect(result.success).toBe(false);
		expect(live.calls).toHaveLength(1);
	});
});

describe("canLiveTouch", () => {
	test("is false for a driver without the four methods", () => {
		const driver: Driver = fakeDriver({ screens: [snapshotOf([])] });
		expect(canLiveTouch(driver)).toBe(false);
	});

	test("is true when all four are there", () => {
		const driver = Object.assign(fakeDriver({ screens: [snapshotOf([])] }), recorder());
		expect(canLiveTouch(driver)).toBe(true);
	});
});
