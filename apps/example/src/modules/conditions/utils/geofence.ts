export type LatLon = { lat: number; lon: number };

/** The fixed circle the Conditions screen watches: 150 m around a point on Apple Park's campus. */
export const GEOFENCE = { lat: 37.3349, lon: -122.009, radiusM: 150 } as const;

const EARTH_RADIUS_M = 6_371_000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance in metres. */
export function distanceMeters(a: LatLon, b: LatLon): number {
	const dLat = toRadians(b.lat - a.lat);
	const dLon = toRadians(b.lon - a.lon);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.lat)) * Math.cos(toRadians(b.lat)) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whether `point` lies within the geofence circle. */
export function isInside(point: LatLon): boolean {
	return distanceMeters(point, GEOFENCE) <= GEOFENCE.radiusM;
}
