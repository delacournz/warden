import { describe, expect, test } from "bun:test";
import { CHROME_HEIGHT, CHROME_WIDTH, SCREEN_PADDING, screenPadding, TITLEBAR_HEIGHT } from "./layout.ts";

describe("window chrome", () => {
	test("vertical chrome is the bar plus the screen padding the markup applies", () => {
		expect(CHROME_HEIGHT).toBe(TITLEBAR_HEIGHT + SCREEN_PADDING.top + SCREEN_PADDING.bottom);
	});

	test("horizontal chrome is the side padding on both sides", () => {
		expect(CHROME_WIDTH).toBe(SCREEN_PADDING.x * 2);
	});

	test("the CSS padding is built from the same numbers", () => {
		const { top, x, bottom } = SCREEN_PADDING;
		expect(screenPadding()).toBe(`${top}px ${x}px ${bottom}px`);
	});
});
