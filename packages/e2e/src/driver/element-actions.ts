import type { Driver, DriverResult, Element } from "./driver.types";

/** The way content moves for a scroll: `down` reveals what is below (forward), `up` what is above (backward). */
export type ScrollDirection = "up" | "down" | "left" | "right";

/**
 * Optional capability next to the frozen `Driver` interface (pattern: `SetsText`): act on a resolved element through
 * the platform's accessibility actions instead of touches, for when a touch means something else. Android with
 * TalkBack on: a tap only moves TalkBack's focus and a one-finger swipe navigates, so a locator `tap` / `swipe` asks
 * here first. Each answers `true` when it did the action, `false` when the driver is not in that mode and the caller
 * should send the touch as before. A raw coordinate tap never comes here: it stays a touch.
 */
export type ActsOnElements = {
	pressElement(element: Element): DriverResult<boolean>;
	/** `within`: the scrolling element; absent = the largest scrollable on screen */
	scrollElement(direction: ScrollDirection, within?: Element): DriverResult<boolean>;
};

export function canActOnElements(driver: Driver): driver is Driver & ActsOnElements {
	return typeof (driver as Partial<ActsOnElements>).pressElement === "function";
}
