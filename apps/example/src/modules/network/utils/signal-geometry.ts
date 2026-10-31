/** Where the arcs fan from, in the glyph's 264 x 168 viewBox. */
export const BASE = { x: 132, y: 138 } as const;

/** Inner to outer. */
export const ARC_RADII = [40, 74, 108] as const;

/** Each arc spans this many degrees either side of straight up. */
const HALF_SPREAD_DEG = 52;

/** An open arc of `radius` around {@link BASE}, fanning up like a signal icon. */
export function arcPath(radius: number): string {
	const a = (HALF_SPREAD_DEG * Math.PI) / 180;
	const dx = radius * Math.sin(a);
	const dy = radius * Math.cos(a);
	const x1 = (BASE.x - dx).toFixed(2);
	const x2 = (BASE.x + dx).toFixed(2);
	const y = (BASE.y - dy).toFixed(2);
	return `M ${x1} ${y} A ${radius} ${radius} 0 0 1 ${x2} ${y}`;
}

/** Which of the three arcs are lit for a link quality 0..3, inner first. */
export function litArcs(quality: number): [boolean, boolean, boolean] {
	return [quality > 0, quality > 1, quality > 2];
}
