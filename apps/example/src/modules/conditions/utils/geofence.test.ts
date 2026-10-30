import { describe, expect, test } from "bun:test";
import { distanceMeters, GEOFENCE, isInside } from "./geofence";

describe("geofence", () => {
	test("distance between identical points is zero", () => {
		expect(distanceMeters(GEOFENCE, GEOFENCE)).toBe(0);
	});

	test("0.001 degrees of latitude is about 111 m", () => {
		const d = distanceMeters(GEOFENCE, { lat: GEOFENCE.lat + 0.001, lon: GEOFENCE.lon });
		expect(d).toBeGreaterThan(105);
		expect(d).toBeLessThan(117);
	});

	test("the centre is inside, 500 m away is outside", () => {
		expect(isInside(GEOFENCE)).toBe(true);
		expect(isInside({ lat: GEOFENCE.lat + 0.0045, lon: GEOFENCE.lon })).toBe(false);
	});
});
