/** Logical pixels. The window is resized from these, so they must match the markup. */
export const TITLEBAR_HEIGHT = 36;
export const SCREEN_INSET = 6;

/** Vertical space around the video: the bar plus the inset above and below the screen. */
export const CHROME_HEIGHT = TITLEBAR_HEIGHT + SCREEN_INSET * 2;

/** Horizontal space around the video: the inset on both sides. */
export const CHROME_WIDTH = SCREEN_INSET * 2;
