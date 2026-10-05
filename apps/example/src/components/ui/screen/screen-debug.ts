/**
 * Translucent colours for the layers `<Screen debug>` paints.
 *
 * Deliberately raw and garish — debug tooling, never product UI, so these are
 * literals rather than theme tokens on purpose. A layer painted in a semantic
 * colour would be invisible against the surface it sits on, which is the one
 * thing this must never be.
 *
 * Exported so a screen's own footer content — a chat composer, say — can paint
 * its bands in the same palette and line up with what the screen draws.
 */
export const SCREEN_DEBUG_COLORS = {
	/** `Screen.Footer`'s sticky wrapper — the layer that shifts with the keyboard. */
	footerSticky: "rgba(255, 0, 0, 0.2)", // red
	/** The footer's safe-area band, which the sticky shift parks behind the keyboard. */
	footerSafeArea: "rgba(255, 140, 0, 0.3)", // orange
	/** The footer's measured content — what drives `footer.height`. */
	footerContent: "rgba(255, 220, 0, 0.3)", // yellow
	/** A scrollable's top spacer, reserving the overlay navbar's height. */
	listTopSpacer: "rgba(0, 90, 255, 0.25)", // blue
	/**
	 * A scrollable's composer spacer — exactly the footer's occupancy, so its
	 * edge nearest the footer must land ON the footer's own edge. A sliver of
	 * `footerSticky` red showing past it means the reserve is short.
	 */
	listComposerSpacer: "rgba(0, 200, 90, 0.3)", // green
	/** Breathing room between the newest message and the composer, above the spacer. */
	listComposerGap: "rgba(0, 200, 200, 0.35)", // cyan
	/** A list's content container bounds. */
	listContent: "rgba(0, 200, 255, 0.1)", // light blue
	/** A composer's fixed layout box — what the footer actually measures. */
	composerLayoutBox: "rgba(150, 0, 255, 0.2)", // purple
	/** A composer's overlay pill: visual height including expansion, driving `overlayHeight`. */
	composerPill: "rgba(255, 0, 180, 0.15)", // pink
	/** A composer's input row wrapper, growing with its content while focused. */
	composerInputWrapper: "rgba(0, 255, 60, 0.2)", // lime
	/** A composer's absolutely positioned input area, bottom-anchored and growing upward. */
	composerInput: "rgba(255, 120, 0, 0.2)", // orange
	/** A composer's actions row. */
	composerActions: "rgba(90, 60, 255, 0.2)", // indigo
} as const;

export type ScreenDebugLayer = keyof typeof SCREEN_DEBUG_COLORS;
