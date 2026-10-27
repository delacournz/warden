/**
 * Per-request budget for the helper's `typeText`: it holds, paces and (for a repeated key) waits per character.
 * The helper's defaults (pace 5, hold 20, repeat gap 50) cost ~38 ms per character on a quiet local simulator; the
 * budget allows ~100 ms (the EAS VirtualMac ran ~3.7x the nominal sleeps) and 200 ms per repeated key.
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
