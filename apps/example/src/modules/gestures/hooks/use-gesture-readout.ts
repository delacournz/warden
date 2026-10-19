import { useCallback, useState } from "react";

/** Size of a gesture surface in dp, from its layout. */
export type SurfaceSize = { width: number; height: number };

/** What the canvas reports once a gesture ends: cumulative values since the last reset. */
export type TransformCommit = {
	scale: number;
	rotation: number;
	translateX: number;
	translateY: number;
	size: SurfaceSize;
};

/** What the trace pad reports once a stroke ends: cumulative path length and where the last stroke stopped. */
export type TraceCommit = {
	length: number;
	endX: number;
	endY: number;
	size: SurfaceSize;
};

/** Committed values (React state, written on gesture end) the readouts render. Rotation is in radians. */
export type GestureReadout = {
	scale: number;
	rotation: number;
	translateX: number;
	translateY: number;
	canvas: SurfaceSize;
	pointers: number;
	traceLength: number;
	traceEndX: number;
	traceEndY: number;
	pad: SurfaceSize;
};

const EMPTY: GestureReadout = {
	scale: 1,
	rotation: 0,
	translateX: 0,
	translateY: 0,
	canvas: { width: 0, height: 0 },
	pointers: 0,
	traceLength: 0,
	traceEndX: 0,
	traceEndY: 0,
	pad: { width: 0, height: 0 },
};

/**
 * The gesture playground's committed state. The surfaces animate on the UI thread and call `commitTransform`,
 * `commitPointers` and `commitTrace` when a gesture ends; `reset` zeroes everything and bumps `resetKey`, which the
 * surfaces use as their React `key` so their shared values start over too.
 */
export function useGestureReadout() {
	const [readout, setReadout] = useState<GestureReadout>(EMPTY);
	const [resetKey, setResetKey] = useState(0);

	const commitTransform = useCallback((next: TransformCommit) => {
		setReadout((prev) => ({
			...prev,
			scale: next.scale,
			rotation: next.rotation,
			translateX: next.translateX,
			translateY: next.translateY,
			canvas: next.size,
		}));
	}, []);

	const commitPointers = useCallback((count: number) => {
		setReadout((prev) => (count > prev.pointers ? { ...prev, pointers: count } : prev));
	}, []);

	const commitTrace = useCallback((next: TraceCommit) => {
		setReadout((prev) => ({
			...prev,
			traceLength: next.length,
			traceEndX: next.endX,
			traceEndY: next.endY,
			pad: next.size,
		}));
	}, []);

	const reset = useCallback(() => {
		setReadout(EMPTY);
		setResetKey((key) => key + 1);
	}, []);

	return { readout, resetKey, commitTransform, commitPointers, commitTrace, reset };
}
