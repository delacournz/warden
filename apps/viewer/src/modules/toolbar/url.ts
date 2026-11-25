/**
 * Turn what the user typed into a URL for the device. Anything with `://` is kept as written (deep
 * links included); a bare host gets `https://`. Empty input or text with spaces is not a URL.
 */
export function normalizeUrl(input: string): string | null {
	const value = input.trim();
	if (value === "" || /\s/.test(value)) return null;
	return value.includes("://") ? value : `https://${value}`;
}
