import type { LatLon } from "@delacour/warden-core/conditions/conditions.types";

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (deg: number): number => (deg * Math.PI) / 180;
const deg = (r: number): number => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function haversineM(a: LatLon, b: LatLon): number {
	const dLat = rad(b.lat - a.lat);
	const dLon = rad(b.lon - a.lon);
	const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
	return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, degrees clockwise from north in [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
	const dLon = rad(b.lon - a.lon);
	const y = Math.sin(dLon) * Math.cos(rad(b.lat));
	const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLon);
	return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The point a fraction `f` (0..1) of the way along the great circle from `a` to `b`. */
export function interpolate(a: LatLon, b: LatLon, f: number): LatLon {
	if (f <= 0) return a;
	if (f >= 1) return b;
	const delta = haversineM(a, b) / EARTH_RADIUS_M;
	if (delta < 1e-12) return a;
	const sinDelta = Math.sin(delta);
	const wa = Math.sin((1 - f) * delta) / sinDelta;
	const wb = Math.sin(f * delta) / sinDelta;
	const lat1 = rad(a.lat);
	const lon1 = rad(a.lon);
	const lat2 = rad(b.lat);
	const lon2 = rad(b.lon);
	const x = wa * Math.cos(lat1) * Math.cos(lon1) + wb * Math.cos(lat2) * Math.cos(lon2);
	const y = wa * Math.cos(lat1) * Math.sin(lon1) + wb * Math.cos(lat2) * Math.sin(lon2);
	const z = wa * Math.sin(lat1) + wb * Math.sin(lat2);
	return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) };
}

export function pathLengthM(points: readonly LatLon[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) total += haversineM(points[i - 1] as LatLon, points[i] as LatLon);
	return total;
}

/**
 * One fix per interval along `points`: a fix every `speedMps * intervalS` metres of path, the first
 * waypoint first and the last waypoint last (no duplicate when the length is an exact multiple).
 */
export function routeSteps(points: readonly LatLon[], speedMps: number, intervalS: number): LatLon[] {
	const first = points[0];
	if (!first) return [];
	if (points.length === 1) return [first];
	const stride = Math.max(speedMps * intervalS, 0.01);
	const steps: LatLon[] = [first];
	let carried = 0;
	for (let i = 1; i < points.length; i++) {
		const from = points[i - 1] as LatLon;
		const to = points[i] as LatLon;
		const leg = haversineM(from, to);
		let at = stride - carried;
		while (at < leg - 1e-6) {
			steps.push(interpolate(from, to, at / leg));
			at += stride;
		}
		carried = leg - (at - stride);
	}
	const last = points[points.length - 1] as LatLon;
	if (haversineM(steps[steps.length - 1] as LatLon, last) > 1e-3) steps.push(last);
	else steps[steps.length - 1] = last;
	return steps;
}

/** 7 decimals (about 1 cm), no trailing zeros, never an exponent. */
export function formatCoord(n: number): string {
	const fixed = n.toFixed(7);
	return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}
