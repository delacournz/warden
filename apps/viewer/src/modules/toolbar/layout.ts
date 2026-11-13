/** Logical pixels. The window is resized from these, so they must match the markup. */
export const TITLEBAR_HEIGHT = 36;
export const SCREEN_INSET = 6;

/**
 * Padding around the screen box under the titlebar: none on top (the bar sits right on the
 * screen), the inset on the sides and below. The markup (`screenPadding`) and the window fit
 * (`CHROME_*`) both read it, so the screen box always has the stream's aspect and never letterboxes.
 */
export const SCREEN_PADDING = { top: 0, x: SCREEN_INSET, bottom: SCREEN_INSET } as const;

/** Vertical space around the video: the bar plus the screen padding above and below. */
export const CHROME_HEIGHT = TITLEBAR_HEIGHT + SCREEN_PADDING.top + SCREEN_PADDING.bottom;

/** Horizontal space around the video: the side padding on both sides. */
export const CHROME_WIDTH = SCREEN_PADDING.x * 2;

/** `SCREEN_PADDING` as a CSS `padding` value. */
export function screenPadding(): string {
	const { top, x, bottom } = SCREEN_PADDING;
	return `${top}px ${x}px ${bottom}px`;
}
