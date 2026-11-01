/** Relative aspect change below which the window is left alone (decoder rounding, not a rotation). */
const REFIT_TOLERANCE = 0.01;

/**
 * Whether the window should be refitted to a new stream aspect (w / h): on the first frame, and
 * whenever the picture's shape changes, e.g. the device rotates.
 */
export function needsRefit(fitted: number | null, aspect: number): boolean {
	if (!Number.isFinite(aspect) || aspect <= 0) return false;
	if (fitted === null) return true;
	return Math.abs(aspect - fitted) / fitted > REFIT_TOLERANCE;
}
