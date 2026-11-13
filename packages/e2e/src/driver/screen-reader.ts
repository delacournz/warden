import type { ScreenReaderState, SpokenLine } from "../a11y/a11y.types";
import type { Driver, DriverResult, Element } from "./driver.types";

/**
 * Optional capability next to the frozen `Driver` interface (pattern: `ReadsA11yEvents`): drive a real screen reader
 * the way a user's swipes and double-taps would. Only Android offers it, and only while TalkBack is on through
 * `a11y({ screenReader: true })`; any call with TalkBack off answers `E_UNSUPPORTED`.
 *
 * `next` / `prev` move TalkBack's accessibility focus one step in its traversal order and answer the node that holds
 * it afterwards (`undefined` at either end). `activate` clicks the focused node (`ACTION_CLICK` on it or its clickable
 * ancestor). `focused` reads the node holding accessibility focus. `spoken` answers what TalkBack said since `since`
 * (opaque cursor, as for `a11yEvents`): from its verbose log when that is on (`source: "talkback"`), else composed
 * from the focus events by the speech model (`source: "simulated"`).
 */
export type SpokenRead = { lines: SpokenLine[]; cursor: number };

export type DrivesScreenReader = {
	screenReaderState(): DriverResult<ScreenReaderState>;
	screenReaderNext(): DriverResult<Element | undefined>;
	screenReaderPrev(): DriverResult<Element | undefined>;
	screenReaderActivate(): DriverResult<void>;
	screenReaderFocused(): DriverResult<Element | undefined>;
	screenReaderSpoken(since?: number): DriverResult<SpokenRead>;
};

export function canDriveScreenReader(driver: Driver): driver is Driver & DrivesScreenReader {
	return typeof (driver as Partial<DrivesScreenReader>).screenReaderNext === "function";
}
