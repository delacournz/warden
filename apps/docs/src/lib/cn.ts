/** Joins class names, dropping falsy entries. */
export function cn(...classes: ReadonlyArray<string | false | null | undefined>): string {
	return classes.filter(Boolean).join(" ");
}
