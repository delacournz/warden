import { DarkTheme, DefaultTheme, ThemeProvider } from "expo-router";
import { type ReactElement, type ReactNode, useMemo } from "react";
import { useNavigationTheme } from "@/hooks/use-navigation-theme";

export type NavigationThemeProps = {
	children: ReactNode;
};

/**
 * Hands the navigator this library's theme colours.
 *
 * Mount it around a `Stack`, `Tabs` or `Drawer`, inside `DelacourProvider`.
 *
 * Not decoration. `expo-router` mounts its `NavigationContainer` with no
 * `theme`, so React Navigation's light default stands however dark the app is —
 * and on iOS the native stack hands `colors.background` to the
 * `UINavigationController`'s view, which is the slab visible between the cards
 * during a push and at their rounded corners. That layer is set from the theme
 * with no escape hatch, so a `contentStyle` in `screenOptions` cannot reach it.
 *
 * `ThemeProvider` comes from `expo-router`, which vendors React Navigation:
 * `@react-navigation/native` is not a package this monorepo can resolve.
 *
 * The framework's own base theme is spread underneath rather than replaced,
 * because `ReactNavigation.Theme` also carries `fonts`, whose shape is
 * platform-specific — restating it here would be a second definition able to
 * drift from the one React Navigation actually ships. Only the colours this
 * library owns are overridden, and `DarkTheme`'s `rgb(1, 1, 1)` background is
 * exactly the kind of near-miss that makes overriding worth doing.
 *
 * Re-renders on a theme change and nothing else, so keep it below the
 * providers — they have no reason to remount when the palette swaps.
 *
 * @example
 * // app/_layout.tsx
 * import { DelacourProvider } from "@/components/ui/provider";
 * import { NavigationTheme } from "@/lib/expo/navigation-theme";
 * import { Stack } from "expo-router";
 *
 * export default function RootLayout() {
 *   return (
 *     <DelacourProvider>
 *       <NavigationTheme>
 *         <Stack screenOptions={{ headerShown: false }} />
 *       </NavigationTheme>
 *     </DelacourProvider>
 *   );
 * }
 */
export function NavigationTheme({ children }: NavigationThemeProps): ReactElement {
	const { dark, colors } = useNavigationTheme();
	const base = dark ? DarkTheme : DefaultTheme;

	const value = useMemo(() => ({ ...base, colors: { ...base.colors, ...colors }, dark }), [base, colors, dark]);

	return <ThemeProvider value={value}>{children}</ThemeProvider>;
}
NavigationTheme.displayName = "DelacourUI.NavigationTheme";
