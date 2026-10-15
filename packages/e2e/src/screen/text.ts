/** A string (whole-text, or substring with `exact:false`) or a RegExp applied as written. */
export type TextMatch = string | RegExp;

export type TextMatchOptions = { exact?: boolean };

/** Collapses every whitespace run (including no-break spaces) to one space and trims. */
export function normalizeText(text: string): string {
	return text.replaceAll(/\s+/g, " ").trim();
}

/**
 * Whether `value` satisfies `match`. A string must equal the whole text after whitespace normalisation (case-sensitive);
 * `exact:false` turns it into a case-insensitive substring. A RegExp is tested as written against the normalised value
 * (its `g`/`y` flags are dropped so repeated calls are not stateful).
 */
export function matchesText(value: string, match: TextMatch, options: TextMatchOptions = {}): boolean {
	const normalized = normalizeText(value);
	if (typeof match !== "string") {
		const flags = match.flags.replaceAll(/[gy]/g, "");
		return new RegExp(match.source, flags).test(normalized);
	}
	const wanted = normalizeText(match);
	if (options.exact === false) return normalized.toLowerCase().includes(wanted.toLowerCase());
	return normalized === wanted;
}
