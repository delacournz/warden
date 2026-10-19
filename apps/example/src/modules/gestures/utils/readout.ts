export type Point = { x: number; y: number };

/** Drops the sign of a number text that rounded to zero ("-0.00" becomes "0.00"). */
function noNegativeZero(text: string): string {
	return Number(text) === 0 ? text.replace("-", "") : text;
}

/** Cumulative pinch scale, two decimals. */
export function formatScale(scale: number): string {
	return scale.toFixed(2);
}

/** Radians to whole degrees, as text. */
export function formatDegrees(radians: number): string {
	return noNegativeZero(String(Math.round((radians * 180) / Math.PI)));
}

/** `value` as a fraction of `size`, two decimals ("0.00" when `size` is 0). */
export function fraction(value: number, size: number): string {
	if (size === 0) return "0.00";
	return noNegativeZero((value / size).toFixed(2));
}

/** Sum of the segment lengths of a polyline. */
export function pathLength(points: readonly Point[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1];
		const b = points[i];
		if (a && b) total += Math.hypot(b.x - a.x, b.y - a.y);
	}
	return total;
}
