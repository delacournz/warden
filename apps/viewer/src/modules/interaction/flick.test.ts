import { describe, expect, test } from "bun:test";
import { classifyFlick, FLICK_MAX_MS, FLICK_MIN_POINTS } from "./flick.ts";

describe("classifyFlick", () => {
	test("fast long travel is a swipe in the dominant direction", () => {
		const from = { x: 100, y: 500 };
		expect(classifyFlick({ from, to: { x: 100, y: 300 }, durationMs: 100 })).toEqual({
			kind: "swipe",
			direction: "up",
		});
		expect(classifyFlick({ from, to: { x: 100, y: 700 }, durationMs: 100 })).toEqual({
			kind: "swipe",
			direction: "down",
		});
		expect(classifyFlick({ from, to: { x: 20, y: 510 }, durationMs: 100 })).toEqual({
			kind: "swipe",
			direction: "left",
		});
		expect(classifyFlick({ from, to: { x: 220, y: 490 }, durationMs: 100 })).toEqual({
			kind: "swipe",
			direction: "right",
		});
	});

	test("slow travel is a drag", () => {
		const result = classifyFlick({ from: { x: 0, y: 0 }, to: { x: 0, y: 200 }, durationMs: FLICK_MAX_MS });
		expect(result).toEqual({ kind: "drag" });
	});

	test("short travel is a drag even when fast", () => {
		const to = { x: FLICK_MIN_POINTS - 1, y: 0 };
		expect(classifyFlick({ from: { x: 0, y: 0 }, to, durationMs: 50 })).toEqual({ kind: "drag" });
	});

	test("exactly the minimum distance just under the time limit is a swipe", () => {
		const to = { x: 0, y: FLICK_MIN_POINTS };
		expect(classifyFlick({ from: { x: 0, y: 0 }, to, durationMs: FLICK_MAX_MS - 1 })).toEqual({
			kind: "swipe",
			direction: "down",
		});
	});

	test("diagonal travel picks the larger axis", () => {
		const result = classifyFlick({ from: { x: 0, y: 0 }, to: { x: 90, y: -60 }, durationMs: 100 });
		expect(result).toEqual({ kind: "swipe", direction: "right" });
	});
});
