/**
 * The pure maths behind the scroll-linked components — `ScrollFade` and the
 * effects that build on `useScrollSource`.
 *
 * **Every function here is a self-contained worklet.** A module-scope helper
 * called from inside a worklet can be missing from that worklet's closure on
 * the UI thread, which surfaces as `undefined is not a function` mid-scroll and
 * is invisible to a unit test. So each function writes its own clamp inline and
 * none of them calls another — do not "tidy" the repetition into a helper.
 *
 * Free of React Native imports, so the whole table is unit-testable.
 */

/** The axis a scrollable moves along. */
export type ScrollOrientation = "vertical" | "horizontal";

/** One end of a scrollable, along its own axis — top or left is `start`. */
export type ScrollEdge = "start" | "end";

/** The scroll-event fields a handler worklet receives, narrowed to what the scroll family reads. */
export type ScrollEventFields = {
	contentOffset: { x: number; y: number };
	contentSize: { width: number; height: number };
	layoutMeasurement: { width: number; height: number };
	velocity?: { x: number; y: number };
};

/** One scroll event, read along one axis. */
export type ScrollReading = { offset: number; contentSize: number; layoutSize: number };

/**
 * The offset and sizes of a scroll event along `orientation` — `y` and heights
 * vertically, `x` and widths horizontally.
 *
 * A negative offset passes through untouched: it is the rubber band at the
 * start, and an effect that wants to stretch with it needs to see it.
 */
export function readScrollEvent(event: ScrollEventFields, orientation: ScrollOrientation): ScrollReading {
	"worklet";
	if (orientation === "horizontal") {
		return {
			offset: event.contentOffset.x,
			contentSize: event.contentSize.width,
			layoutSize: event.layoutMeasurement.width,
		};
	}

	return {
		offset: event.contentOffset.y,
		contentSize: event.contentSize.height,
		layoutSize: event.layoutMeasurement.height,
	};
}

export type ScrollEdgeState = {
	edge: ScrollEdge;
	offset: number;
	contentSize: number;
	layoutSize: number;
	/** Points of travel from fully clear to fully in. 0 makes it a step. */
	fadeInDistance: number;
	/**
	 * Points at the end of the frame covered by something drawn over it — an
	 * open keyboard. `KeyboardAwareScrollView` makes room for the keyboard with
	 * a content inset, which the scroll event leaves out of `contentSize`, so
	 * content that fits the whole frame can still run on under the cover.
	 * @default 0
	 */
	coveredEnd?: number;
};

/**
 * The 0..1 opacity of an affordance at one edge of a scrollable — a fade, a
 * blur, a hairline — which is in exactly while there is content past that edge.
 *
 * - **start** is clear at rest and arrives over the first `fadeInDistance`
 *   points of travel. Rubber-banding past the start keeps it clear.
 * - **end** is in at rest and leaves over the last `fadeInDistance` points.
 *   Bouncing past the end keeps it clear.
 * - **Short content** — no further to scroll — clears both: an edge that
 *   promises content which does not exist is worse than a hard edge.
 * - **Unmeasured** — either size still 0 — lets the start follow the offset
 *   and draws the end. A `Screen`'s source learns its sizes only from the first
 *   scroll event, and a tall list must show its end fade at rest.
 */
export function scrollEdgeOpacity(state: ScrollEdgeState): number {
	"worklet";
	const { edge, offset, contentSize, layoutSize, fadeInDistance, coveredEnd = 0 } = state;
	const isMeasured = contentSize > 0 && layoutSize > 0;
	// Measured against the part of the frame that is still visible.
	const maxScroll = contentSize - (layoutSize - coveredEnd);

	if (isMeasured && maxScroll <= 0) return 0;

	// Points of content past this edge.
	let past: number;
	if (edge === "start") {
		past = offset;
	} else {
		if (!isMeasured) return 1;
		past = maxScroll - offset;
	}

	if (fadeInDistance <= 0) return past > 0 ? 1 : 0;

	const ratio = past / fadeInDistance;
	return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}

/**
 * Where `value` sits between `from` and `to`, as a clamped 0..1.
 *
 * `from` may exceed `to` — the ramp then runs downward, which is how an effect
 * that leaves as the scroll arrives is written. With `from === to` it is a
 * step: 1 at or past the point, 0 before it.
 */
export function scrollProgress(value: number, from: number, to: number): number {
	"worklet";
	if (from === to) return value >= to ? 1 : 0;

	const ratio = (value - from) / (to - from);
	return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}
