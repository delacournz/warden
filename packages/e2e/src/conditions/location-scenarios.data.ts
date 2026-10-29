import type { LatLon, LocationScenario } from "@delacour/warden-core/conditions/conditions.types";

/**
 * Apple's names for the three simulated-location scenarios `simctl location <udid> run` knows (verify
 * with `xcrun simctl location <udid> list`).
 */
export const IOS_SCENARIO_NAMES: Record<LocationScenario, string> = {
	"city-run": "City Run",
	"city-bike": "City Bicycle Ride",
	freeway: "Freeway Drive",
};

export type ScenarioRoute = { points: readonly LatLon[]; speedMps: number; loop: boolean };

/**
 * Android parity: a similar path and pace for each scenario, played by the route ticker. These are
 * warden's own waypoints around Apple Park, Cupertino, not Apple's data: same character (walking
 * pace loop, cycling loop, highway stretch), not identical coordinates.
 */
export const ANDROID_SCENARIOS: Record<LocationScenario, ScenarioRoute> = {
	"city-run": {
		speedMps: 3,
		loop: true,
		points: [
			{ lat: 37.3349, lon: -122.009 },
			{ lat: 37.3349, lon: -122.0125 },
			{ lat: 37.3322, lon: -122.0125 },
			{ lat: 37.3322, lon: -122.009 },
			{ lat: 37.3349, lon: -122.009 },
		],
	},
	"city-bike": {
		speedMps: 6,
		loop: true,
		points: [
			{ lat: 37.3318, lon: -122.0312 },
			{ lat: 37.3318, lon: -122.0215 },
			{ lat: 37.3392, lon: -122.0215 },
			{ lat: 37.3392, lon: -122.0312 },
			{ lat: 37.3318, lon: -122.0312 },
		],
	},
	freeway: {
		speedMps: 29,
		loop: false,
		points: [
			{ lat: 37.3318, lon: -122.0312 },
			{ lat: 37.3688, lon: -122.0363 },
			{ lat: 37.4085, lon: -122.0745 },
			{ lat: 37.4419, lon: -122.143 },
			{ lat: 37.4848, lon: -122.2281 },
		],
	},
};
