import { describe, expect, test } from "bun:test";
import { distanceMeters, formatDistance, formatSpeed, toLocal } from "./geo";

const START = { lat: 37.3349, lon: -122.009 };

describe("distanceMeters", () => {
	test("zero for the same point", () => expect(distanceMeters(START, START)).toBe(0));
	test("0.001 degrees of latitude is about 111 m", () => {
		const d = distanceMeters(START, { lat: START.lat + 0.001, lon: START.lon });
		expect(d).toBeGreaterThan(110);
		expect(d).toBeLessThan(112);
	});
	test("a degree of longitude is shorter by cos(latitude)", () => {
		const d = distanceMeters(START, { lat: START.lat, lon: START.lon + 0.001 });
		expect(d).toBeGreaterThan(88);
		expect(d).toBeLessThan(89.5);
	});
});

describe("toLocal", () => {
	test("origin maps to 0,0", () => expect(toLocal(START, START)).toEqual({ x: 0, y: 0 }));
	test("north is +y, east is +x", () => {
		const north = toLocal(START, { lat: START.lat + 0.001, lon: START.lon });
		expect(north.x).toBeCloseTo(0, 6);
		expect(north.y).toBeGreaterThan(110);
		const east = toLocal(START, { lat: START.lat, lon: START.lon + 0.001 });
		expect(east.y).toBeCloseTo(0, 6);
		expect(east.x).toBeGreaterThan(88);
	});
	test("agrees with the haversine distance over a short span", () => {
		const p = { lat: START.lat + 0.004, lon: START.lon + 0.003 };
		const { x, y } = toLocal(START, p);
		expect(Math.abs(Math.hypot(x, y) - distanceMeters(START, p))).toBeLessThan(2);
	});
});

describe("formatDistance", () => {
	test("metres below a kilometre", () => {
		expect(formatDistance(0)).toBe("0 m");
		expect(formatDistance(86.4)).toBe("86 m");
		expect(formatDistance(999.4)).toBe("999 m");
	});
	test("kilometres with two decimals from 1 km", () => {
		expect(formatDistance(1000)).toBe("1.00 km");
		expect(formatDistance(1243)).toBe("1.24 km");
	});
});

describe("formatSpeed", () => {
	test("one decimal, or a dash when unknown", () => {
		expect(formatSpeed(25)).toBe("25.0 m/s");
		expect(formatSpeed(0.04)).toBe("0.0 m/s");
		expect(formatSpeed(null)).toBe("-");
	});
});
