import { useMemo } from "react";
import { useUniwind } from "uniwind";
import { NAVIGATION_THEME_TOKENS, type NavigationTheme, omitUnresolvedColors } from "@/lib/navigation-theme";
import { useThemeColor } from "./use-theme-color";

// Re-exported so the mapping is reachable beside the hook that reads it; it
// lives in `lib` only because `bun test` cannot follow this module's React
// Native imports.
export {
	NAVIGATION_THEME_TOKENS,
	type NavigationTheme,
	type NavigationThemeSlot,
} from "@/lib/navigation-theme";

/**
 * The active theme's colours, shaped for a React Navigation theme.
 *
 * Exists because a navigator paints its own chrome from its own theme, and
 * nothing connects that to this library's tokens. `expo-router` mounts its
 * `NavigationContainer` with no `theme`, so the light default stands however
 * dark the app is: on iOS the native stack hands `colors.background` to the
 * `UINavigationController`'s view, which is the slab visible between cards
 * during a push. That layer is hardcoded to the theme, so a `contentStyle` in
 * `screenOptions` cannot reach it — only a theme can.
 *
 * Returns plain values rather than a `Theme`, and imports nothing from a
 * navigation library. That is deliberate: this package takes no navigation
 * dependency — the same reason `Screen.Navbar.BackButton` takes an `onPress`
 * instead of calling a router — so the app owns the wiring and this owns the
 * colours. It also sidesteps restating React Navigation's `fonts`, whose shape
 * is platform-specific and would be a second definition able to drift.
 *
 * `dark` comes from Uniwind's active theme, never React Native's
 * `useColorScheme`: an app that lets the user force light or dark against the
 * system setting would otherwise theme its navigator the wrong way round.
 *
 * Reactive. Every colour is read through {@link useThemeColor}, which
 * subscribes to Uniwind's theme changes, so switching theme re-renders the
 * caller with new values rather than needing a reload.
 *
 * @example
 * // expo-router. `ThemeProvider` comes from `expo-router`, which vendors
 * // React Navigation — `@react-navigation/native` does not resolve.
 * import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from "expo-router";
 *
 * function NavigationTheme({ children }: { children: ReactNode }) {
 *   const { dark, colors } = useNavigationTheme();
 *   const base = dark ? DarkTheme : DefaultTheme;
 *   const value = useMemo(
 *     () => ({ ...base, dark, colors: { ...base.colors, ...colors } }),
 *     [base, dark, colors]
 *   );
 *
 *   return <ThemeProvider value={value}>{children}</ThemeProvider>;
 * }
 */
export function useNavigationTheme(): NavigationTheme {
	const { theme } = useUniwind();

	// Written out one call per slot rather than looped: a hook cannot be called
	// from inside a map, however stable the list looks.
	const background = useThemeColor(NAVIGATION_THEME_TOKENS.background);
	const card = useThemeColor(NAVIGATION_THEME_TOKENS.card);
	const text = useThemeColor(NAVIGATION_THEME_TOKENS.text);
	const border = useThemeColor(NAVIGATION_THEME_TOKENS.border);
	const primary = useThemeColor(NAVIGATION_THEME_TOKENS.primary);
	const notification = useThemeColor(NAVIGATION_THEME_TOKENS.notification);

	const dark = theme === "dark";

	return useMemo(
		() => ({
			colors: omitUnresolvedColors({ background, border, card, notification, primary, text }),
			dark,
		}),
		[dark, background, border, card, notification, primary, text]
	);
}
