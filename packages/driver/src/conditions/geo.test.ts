import { describe, expect, test } from "bun:test";
import { geoMath } from "./geo";

const CUPERTINO = { lat: 37.3318, lon: -122.0312 };
const SF = { lat: 37.7749, lon: -122.4194 };

describe("geoMath.haversineM", () => {
	test("zero for the same point", () => {
		expect(geoMath.haversineM(CUPERTINO, CUPERTINO)).toBe(0);
	});
	test("one degree of latitude is about 111.2 km", () => {
		expect(geoMath.haversineM({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(111_195, -2);
	});
	test("Cupertino to San Francisco is about 60 km", () => {
		expect(geoMath.haversineM(CUPERTINO, SF) / 1000).toBeCloseTo(60, 0);
	});
	test("symmetric", () => {
		expect(geoMath.haversineM(CUPERTINO, SF)).toBeCloseTo(geoMath.haversineM(SF, CUPERTINO), 6);
	});
});

describe("geoMath.bearingDeg", () => {
	test("cardinal directions", () => {
		const o = { lat: 0, lon: 0 };
		expect(geoMath.bearingDeg(o, { lat: 1, lon: 0 })).toBeCloseTo(0, 6);
		expect(geoMath.bearingDeg(o, { lat: 0, lon: 1 })).toBeCloseTo(90, 6);
		expect(geoMath.bearingDeg(o, { lat: -1, lon: 0 })).toBeCloseTo(180, 6);
		expect(geoMath.bearingDeg(o, { lat: 0, lon: -1 })).toBeCloseTo(270, 6);
	});
});

describe("geoMath.interpolate", () => {
	test("endpoints", () => {
		expect(geoMath.interpolate(CUPERTINO, SF, 0)).toEqual(CUPERTINO);
		expect(geoMath.interpolate(CUPERTINO, SF, 1)).toEqual(SF);
	});
	test("midpoint is equidistant", () => {
		const mid = geoMath.interpolate(CUPERTINO, SF, 0.5);
		expect(geoMath.haversineM(CUPERTINO, mid)).toBeCloseTo(geoMath.haversineM(mid, SF), 0);
	});
	test("identical points do not divide by zero", () => {
		expect(geoMath.interpolate(CUPERTINO, CUPERTINO, 0.3)).toEqual(CUPERTINO);
	});
});

describe("geoMath.routeSteps", () => {
	const a = { lat: 0, lon: 0 };
	const b = { lat: 0, lon: 0.01 };
	const len = geoMath.haversineM(a, b);

	test("path length sums legs", () => {
		const c = { lat: 0.01, lon: 0.01 };
		expect(geoMath.pathLengthM([a, b, c])).toBeCloseTo(geoMath.haversineM(a, b) + geoMath.haversineM(b, c), 6);
	});

	test("step count is floor(length / stride) + 1 and ends on the last waypoint", () => {
		const steps = geoMath.routeSteps([a, b], 20, 1);
		expect(steps.length).toBe(Math.floor(len / 20) + 2);
		expect(steps[0]).toEqual(a);
		expect(steps[steps.length - 1]).toEqual(b);
	});

	test("stride is speed times interval", () => {
		const steps = geoMath.routeSteps([a, b], 10, 2);
		expect(geoMath.haversineM(steps[0] as never, steps[1] as never)).toBeCloseTo(20, 0);
	});

	test("exact multiple has no duplicate tail", () => {
		const exact = geoMath.interpolate(a, b, 0.5);
		const half = geoMath.haversineM(a, exact);
		const steps = geoMath.routeSteps([a, exact], half, 1);
		expect(steps.length).toBe(2);
	});

	test("walks through intermediate waypoints", () => {
		const c = { lat: 0.01, lon: 0.01 };
		const steps = geoMath.routeSteps([a, b, c], 50, 1);
		expect(steps[steps.length - 1]).toEqual(c);
		const nearCorner = steps.some((s) => geoMath.haversineM(s, b) < 50);
		expect(nearCorner).toBe(true);
	});

	test("single point yields that point", () => {
		expect(geoMath.routeSteps([a], 20, 1)).toEqual([a]);
	});

	test("empty yields nothing, non-positive stride is clamped", () => {
		expect(geoMath.routeSteps([], 20, 1)).toEqual([]);
		expect(geoMath.routeSteps([a, b], 0, 1).length).toBeGreaterThan(1);
	});
});

describe("geoMath.formatCoord", () => {
	test("trims trailing zeros, no exponent", () => {
		expect(geoMath.formatCoord(174.7633)).toBe("174.7633");
		expect(geoMath.formatCoord(-122)).toBe("-122");
		expect(geoMath.formatCoord(0.0000001)).toBe("0.0000001");
		expect(geoMath.formatCoord(1.23456789123)).toBe("1.2345679");
	});
});
