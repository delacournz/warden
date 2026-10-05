/**
 * React Navigation's colour slots, mapped to this library's semantic tokens.
 *
 * Lives here, free of React Native imports, so the mapping is reachable from
 * `bun test` — `hooks/use-navigation-theme` cannot be, since Bun's transpiler
 * cannot parse React Native's Flow-typed source. See AGENTS.md.
 *
 * A slot pointing at a token no theme emits would resolve to `undefined`, be
 * dropped, and silently leave React Navigation's own light default in place —
 * which is the exact failure the hook exists to fix. The test asserts every
 * token here is declared in both variants of `styles/theme.css`.
 */
export const NAVIGATION_THEME_TOKENS = {
	background: "background",
	card: "card",
	text: "foreground",
	border: "border",
	primary: "primary",
	notification: "destructive",
} as const;

export type NavigationThemeSlot = keyof typeof NAVIGATION_THEME_TOKENS;

/** The resolved colours, and whether the active theme is a dark one. */
export type NavigationTheme = {
	dark: boolean;
	/**
	 * Resolved colours by slot. A slot the active theme does not emit is
	 * ABSENT rather than `undefined`, so spreading this over a base theme
	 * leaves that slot's default in place instead of punching a hole in it.
	 */
	colors: Partial<Record<NavigationThemeSlot, string>>;
};

/**
 * Drops the slots that resolved to nothing.
 *
 * The result is spread over a base theme, and `{ ...base, background: undefined }`
 * overwrites the default with `undefined` rather than leaving it — a navigator
 * with no background at all, which reads as a transparent hole rather than as
 * a missing token.
 */
export function omitUnresolvedColors(
	colors: Record<NavigationThemeSlot, string | undefined>
): Partial<Record<NavigationThemeSlot, string>> {
	const resolved: Partial<Record<NavigationThemeSlot, string>> = {};

	for (const [slot, value] of Object.entries(colors) as [NavigationThemeSlot, string | undefined][]) {
		if (value !== undefined) resolved[slot] = value;
	}

	return resolved;
}
