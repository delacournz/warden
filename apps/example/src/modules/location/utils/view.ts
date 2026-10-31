import type { Point } from "./geo";

/** Which part of the plane the glyph shows: `scale` pixels per metre, centred on (`cx`, `cy`) metres. */
export type View = { scale: number; cx: number; cy: number };

/**
 * The view that fits `points` and the geofence circle (radius `radius` around 0,0) into a square whose half side is
 * `half` pixels. The circle is always part of the fit, so the geofence never leaves the glyph.
 */
export function fitView(points: readonly Point[], radius: number, half: number): View {
	let minX = -radius;
	let maxX = radius;
	let minY = -radius;
	let maxY = radius;
	for (const p of points) {
		minX = Math.min(minX, p.x);
		maxX = Math.max(maxX, p.x);
		minY = Math.min(minY, p.y);
		maxY = Math.max(maxY, p.y);
	}
	const halfExtent = Math.max(maxX - minX, maxY - minY) / 2;
	return { scale: half / halfExtent, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
}

/** Metres to pixels inside a box whose centre is `half`, `half`; north is up. */
export function toScreen(view: View, point: Point, half: number): Point {
	return { x: half + (point.x - view.cx) * view.scale, y: half - (point.y - view.cy) * view.scale };
}

const NICE_STEPS = [1, 2, 5] as const;

/** The longest 1-2-5 length (1 m, 2 m, 5 m, 10 m ...) that stays within `maxPx` at this scale, with its label. */
export function scaleBar(scale: number, maxPx: number): { meters: number; px: number; label: string } {
	const maxMeters = maxPx / scale;
	let meters = 1;
	for (
		let exponent = Math.floor(Math.log10(maxMeters)) - 1;
		exponent <= Math.floor(Math.log10(maxMeters));
		exponent++
	) {
		for (const step of NICE_STEPS) {
			const candidate = step * 10 ** exponent;
			if (candidate <= maxMeters) meters = candidate;
		}
	}
	const label = meters >= 1000 ? `${meters / 1000} km` : `${meters} m`;
	return { meters, px: meters * scale, label };
}

/**
 * SVG path through a flat `[x0, y0, x1, y1, ...]` list of metres, projected with `view`. Empty below two points.
 * Runs on the UI thread, as a worklet, so the track follows the view while it animates.
 */
export function trackPath(flat: readonly number[], view: View, half: number): string {
	"worklet";
	if (flat.length < 4) return "";
	let d = "";
	for (let i = 0; i < flat.length; i += 2) {
		const x = half + (flat[i] - view.cx) * view.scale;
		const y = half - (flat[i + 1] - view.cy) * view.scale;
		d += `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
	}
	return d;
}
