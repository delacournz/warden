import { ok } from "@delacour/warden-types/result";
import type { Driver, DriverResult, KeyName } from "./driver.types";

/**
 * The one place that decides how text and keys are sent to a device (specs' `fill`/`type`/`clear` and `warden ui
 * fill`/`type` all go through it).
 *
 * iOS: a multi-character `typeText` is one composite HID event and the app drops the tail of it, and keys sent
 * closer together than the app digests them (about 45-50 ms a character) arrive truncated or garbled. Measured on
 * the example app: 25 ms between keys is reliable (10 ms and 5 ms are not). So on iOS each grapheme is its own
 * request, `KEY_PACE_MS` apart, and so is each Backspace. When the helper paces keys itself (simd-core), set
 * `KEY_PACE_MS` to 0 and `SPLIT_TEXT` to false here and nothing else changes.
 */

/** Gap after each key on iOS. */
export const KEY_PACE_MS = 25;
/** iOS types one grapheme per request. */
export const SPLIT_TEXT = true;

export type Sleep = (ms: number) => Promise<void>;

/**
 * Optional fast path a driver can offer next to the frozen `Driver` interface: `times` presses of `key` in one
 * device round trip. Android needs it because every `input keyevent` is a process start (clearing a 20 character
 * field one key at a time takes seconds); iOS paces keys itself.
 */
export type RepeatingKeys = { pressKeyRepeat(key: KeyName, times: number): DriverResult<void> };

export function canRepeatKeys(driver: Driver): driver is Driver & RepeatingKeys {
	return typeof (driver as Partial<RepeatingKeys>).pressKeyRepeat === "function";
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function graphemesOf(text: string): string[] {
	return Array.from(segmenter.segment(text), (part) => part.segment);
}

async function pace(driver: Driver, sleep: Sleep): Promise<void> {
	if (driver.platform === "ios" && KEY_PACE_MS > 0) await sleep(KEY_PACE_MS);
}

/** Types `text` at the caret. Android types the whole string in one call. */
export async function typeText(driver: Driver, sleep: Sleep, text: string): DriverResult<void> {
	if (driver.platform !== "ios" || !SPLIT_TEXT) {
		const typed = await driver.typeText(text);
		if (typed.success) await pace(driver, sleep);
		return typed;
	}
	for (const character of graphemesOf(text)) {
		const typed = await driver.typeText(character);
		if (!typed.success) return typed;
		await pace(driver, sleep);
	}
	return ok(undefined);
}

/** Presses `key` `times` times, paced like typed characters. */
export async function pressKeys(driver: Driver, sleep: Sleep, key: KeyName, times: number): DriverResult<void> {
	if (times > 1 && canRepeatKeys(driver)) return driver.pressKeyRepeat(key, times);
	for (let press = 0; press < times; press += 1) {
		const pressed = await driver.key(key);
		if (!pressed.success) return pressed;
		await pace(driver, sleep);
	}
	return ok(undefined);
}
