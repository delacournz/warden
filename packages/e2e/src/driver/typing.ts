import { ok } from "@delacour/warden-types/result";
import type { Driver, DriverResult, KeyName } from "./driver.types";

/**
 * The one place that decides how text and keys are sent to a device (specs' `fill`/`type`/`clear` and `warden ui
 * fill`/`type` all go through it).
 *
 * iOS: `warden-simd` holds, paces and spaces repeated keys itself (`WARDEN_SIMD_PACE_MS`, `WARDEN_SIMD_HOLD_MS`,
 * `WARDEN_SIMD_REPEAT_GAP_MS`), so the whole string goes in one request and the client adds no gap. Before that
 * the client sent one grapheme per request, 25 ms apart (set `KEY_PACE_MS` 25 and `SPLIT_TEXT` true to go back).
 */

/** Gap after each key on iOS. */
export const KEY_PACE_MS = 0;
/** iOS types one grapheme per request. */
export const SPLIT_TEXT = false;

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

/**
 * Optional fast path next to the frozen `Driver`: select everything in the focused text field (iOS Cmd+A through
 * `warden-simd`, Android Ctrl+A through `input keycombination` on API 33+), so one Backspace empties a field of any
 * length instead of one per character. A field that refuses the shortcut is caught by the read-back after the fill.
 */
export type SelectsAll = { selectAll(): DriverResult<void> };

export function canSelectAll(driver: Driver): driver is Driver & SelectsAll {
	return typeof (driver as Partial<SelectsAll>).selectAll === "function";
}

/**
 * Optional fast path next to the frozen `Driver`: replace the whole text of the focused field in one call (Android
 * `warden-uiad` `setText`, `ACTION_SET_TEXT`: the same action its `typeText` inserts with). `screen/field.ts` uses it,
 * opt-in only (`ClearMethod` `setText`, or `WARDEN_ANDROID_SETTEXT=1`), for a `fill` over a field that holds text,
 * instead of select-all then typing; the read-back checks it took. A refusal (no server, no focused input) is an error,
 * and the caller types the old way. Opt-in because the server writes to the node its cached focus names, which may
 * still be the field focused before the tap.
 */
export type SetsText = { setText(text: string): DriverResult<void> };

export function canSetText(driver: Driver): driver is Driver & SetsText {
	return typeof (driver as Partial<SetsText>).setText === "function";
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
