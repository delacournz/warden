/** Per-request budget for the helper's `typeText`: it holds, paces and (for a repeated key) waits per character. */
export const TYPE_BASE_MS = 10_000;
export const TYPE_PER_CHAR_MS = 70;
export const TYPE_PER_REPEAT_MS = 300;

/** Base + ~70 ms per character + 300 ms per character equal to the one before it. */
export function typeTextBudgetMs(text: string): number {
	const characters = Array.from(text);
	let repeats = 0;
	for (let index = 1; index < characters.length; index += 1) {
		if (characters[index] === characters[index - 1]) repeats += 1;
	}
	return TYPE_BASE_MS + characters.length * TYPE_PER_CHAR_MS + repeats * TYPE_PER_REPEAT_MS;
}
