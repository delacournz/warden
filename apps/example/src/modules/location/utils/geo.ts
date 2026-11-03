export type LatLon = { lat: number; lon: number };

/** A point in metres east (`x`) and north (`y`) of a local origin. */
export type Point = { x: number; y: number };

/** Radius of the geofence drawn around the first fix of a session. */
export const GEOFENCE_RADIUS_M = 150;

const EARTH_RADIUS_M = 6_371_000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance in metres. */
export function distanceMeters(a: LatLon, b: LatLon): number {
	const dLat = toRadians(b.lat - a.lat);
	const dLon = toRadians(b.lon - a.lon);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Local equirectangular projection around `origin`: metres east and north. Accurate to a few metres over the
 * kilometres a route spans, which is all the glyph needs.
 */
export function toLocal(origin: LatLon, point: LatLon): Point {
	const x = toRadians(point.lon - origin.lon) * Math.cos(toRadians(origin.lat)) * EARTH_RADIUS_M;
	const y = toRadians(point.lat - origin.lat) * EARTH_RADIUS_M;
	return { x, y };
}

/** `86 m` below a kilometre, `1.24 km` from there. */
export function formatDistance(meters: number): string {
	return meters < 999.5 ? `${Math.round(meters)} m` : `${(meters / 1000).toFixed(2)} km`;
}

/** `25.0 m/s`, or `-` when no speed is known. */
export function formatSpeed(speed: number | null): string {
	return speed === null ? "-" : `${speed.toFixed(1)} m/s`;
}
