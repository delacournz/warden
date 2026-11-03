import { describe, expect, test } from "bun:test";
import { fitView, scaleBar, toScreen, trackPath } from "./view";

const HALF = 100;

describe("fitView", () => {
	test("no points fits the geofence circle alone, centred", () => {
		const v = fitView([], 150, HALF);
		expect(v.cx).toBe(0);
		expect(v.cy).toBe(0);
		expect(v.scale).toBeCloseTo(HALF / 150, 6);
	});
	test("points inside the circle change nothing", () => {
		expect(fitView([{ x: 10, y: 20 }], 150, HALF)).toEqual(fitView([], 150, HALF));
	});
	test("a far point zooms out so everything fits and recentres on the span", () => {
		const v = fitView(
			[
				{ x: 0, y: 0 },
				{ x: 1000, y: 0 },
			],
			150,
			HALF
		);
		expect(v.cx).toBeCloseTo(425, 6);
		expect(v.scale).toBeCloseTo(HALF / 575, 6);
		const left = toScreen(v, { x: -150, y: 0 }, HALF);
		const right = toScreen(v, { x: 1000, y: 0 }, HALF);
		expect(left.x).toBeGreaterThanOrEqual(-1e-9);
		expect(right.x).toBeLessThanOrEqual(2 * HALF + 1e-9);
	});
	test("fits the taller axis", () => {
		const v = fitView([{ x: 0, y: 900 }], 150, HALF);
		expect(v.cy).toBeCloseTo(375, 6);
		expect(v.scale).toBeCloseTo(HALF / 525, 6);
	});
});

describe("toScreen", () => {
	test("the view centre lands mid-box and north is up", () => {
		const v = { scale: 2, cx: 10, cy: 10 };
		expect(toScreen(v, { x: 10, y: 10 }, HALF)).toEqual({ x: HALF, y: HALF });
		expect(toScreen(v, { x: 10, y: 20 }, HALF).y).toBe(HALF - 20);
		expect(toScreen(v, { x: 20, y: 10 }, HALF).x).toBe(HALF + 20);
	});
});

describe("scaleBar", () => {
	test("picks the longest 1-2-5 length that fits", () => {
		expect(scaleBar(0.5, 80)).toEqual({ meters: 100, px: 50, label: "100 m" });
		expect(scaleBar(0.1, 80)).toEqual({ meters: 500, px: 50, label: "500 m" });
		expect(scaleBar(0.04, 80)).toEqual({ meters: 2000, px: 80, label: "2 km" });
		expect(scaleBar(0.01, 80)).toEqual({ meters: 5000, px: 50, label: "5 km" });
	});
	test("kilometre labels", () => expect(scaleBar(0.08, 80).label).toBe("1 km"));
	test("never wider than the cap", () => {
		for (const scale of [3, 0.7, 0.123, 0.0031]) expect(scaleBar(scale, 80).px).toBeLessThanOrEqual(80);
	});
});

describe("trackPath", () => {
	test("empty for fewer than two points", () => {
		expect(trackPath([], { scale: 1, cx: 0, cy: 0 }, HALF)).toBe("");
		expect(trackPath([0, 0], { scale: 1, cx: 0, cy: 0 }, HALF)).toBe("");
	});
	test("M then L through the projected points", () => {
		const d = trackPath([0, 0, 10, 10], { scale: 1, cx: 0, cy: 0 }, HALF);
		expect(d).toBe("M100.0 100.0L110.0 90.0");
	});
});
