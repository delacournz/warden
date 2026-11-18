/**
 * Per-request budget for the helper's `typeText`: it holds, paces and (for a repeated key) waits per character.
 * The helper's defaults (pace 5, hold 20, repeat gap 50) cost ~38 ms per character on a quiet local simulator; the
 * budget allows ~100 ms (the EAS VirtualMac ran ~3.7x the nominal sleeps) and 200 ms per repeated key. The one
 * lead-in pause after the first key (60 ms) fits in the base.
 */
export const TYPE_BASE_MS = 10_000;
export const TYPE_PER_CHAR_MS = 100;
export const TYPE_PER_REPEAT_MS = 200;

/** Base + ~100 ms per character + 200 ms per character equal to the one before it. */
export function typeTextBudgetMs(text: string): number {
	const characters = Array.from(text);
	let repeats = 0;
	for (let index = 1; index < characters.length; index += 1) {
		if (characters[index] === characters[index - 1]) repeats += 1;
	}
	return TYPE_BASE_MS + characters.length * TYPE_PER_CHAR_MS + repeats * TYPE_PER_REPEAT_MS;
}

/** The XCUITest runner on a real device types one character per `typeText` call, each waiting for the app to go idle. */
export const DEVICE_TYPE_PER_CHAR_MS = 600;

/** Base + ~600 ms per character: the runner's per-character typing on a real device. */
export function deviceTypeTextBudgetMs(text: string): number {
	return TYPE_BASE_MS + Array.from(text).length * DEVICE_TYPE_PER_CHAR_MS;
}

/**
 * Key pacing for `TypesQuickly` (`driver/typing.ts`), sent per request in place of the helper's defaults (pace 5, hold
 * 20, repeat gap 50, lead 60). Only the first attempt of a verified `fill` uses it: the read-back catches a lost key
 * and the retry types at the defaults. Measured 2026-11-13 against the example app's controlled React Native inputs
 * (sign-in email, 15 and 60 characters with shifted keys, repeats and punctuation; local sim, Xcode 27): this pacing
 * typed ~22 ms/char at 15 characters and ~16 at 60 (the defaults ~38) and lost 0 of 56 fills, and the field caught up
 * as fast as with the defaults (the app digests keys at about this rate). Hold 5 lost 1 of 28 (the tail of a 60
 * character string, while the field lagged ~340 ms behind the keys); no hold or lead lost 5 of 24.
 */
export const QUICK_KEY_PACING = { paceMs: 0, holdMs: 10, repeatGapMs: 10, leadMs: 60 } as const;

/** The helper's key pacing variables. A user who sets one is tuning for a slow host or a stubborn field. */
export const KEY_PACING_ENV = [
	"WARDEN_SIMD_PACE_MS",
	"WARDEN_SIMD_HOLD_MS",
	"WARDEN_SIMD_REPEAT_GAP_MS",
	"WARDEN_SIMD_LEAD_MS",
] as const;

/** Whether `env` sets any of `KEY_PACING_ENV`: then quick typing is off and every key uses the helper's (their) pacing. */
export function keyPacingSet(env: Readonly<Record<string, string | undefined>>): boolean {
	return KEY_PACING_ENV.some((name) => (env[name] ?? "") !== "");
}
