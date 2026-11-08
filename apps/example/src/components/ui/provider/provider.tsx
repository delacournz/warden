import type { ReactElement, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { initialWindowMetrics, type Metrics, SafeAreaProvider } from "react-native-safe-area-context";
import { CalmMotionProvider } from "@/hooks/use-calm-motion";
import { KeyboardStateSync } from "@/hooks/use-keyboard-state-sync";

export type DelacourProviderProps = {
	children: ReactNode;
	/**
	 * Safe-area insets and frame to render the first frame against, before the
	 * native provider has measured anything.
	 *
	 * Defaults to `initialWindowMetrics`, the snapshot the native module captured
	 * at launch, because `SafeAreaProvider` renders NOTHING — not unstyled
	 * children, `null` — until its first `onInsetsChange` lands. Without a seed
	 * every cold start shows a blank frame.
	 *
	 * Pass `null` to opt out. A default parameter only fires on `undefined`, so
	 * `null` is a value here rather than an absence.
	 */
	initialMetrics?: Metrics | null;
	/**
	 * Hold every decorative loop still — a skeleton's shimmer or pulse — whatever
	 * the OS reduce-motion setting says. Defaults to `false`.
	 *
	 * For an E2E build. A test runner that waits for the screen to stop moving
	 * before each gesture (Argent, Detox, Maestro) pays its whole timeout on any
	 * screen holding a loop that never ends. Motion that *is* the behaviour — a
	 * `Spinner`, an indeterminate `Progress` — keeps moving either way.
	 */
	isMotionCalm?: boolean;
	/**
	 * Style for the outermost `GestureHandlerRootView`.
	 *
	 * Forwarded untouched, with no default merged in: the gesture root applies
	 * its own `{ flex: 1 }` whenever `style` is undefined. Pass one and that
	 * default is gone, so include `flex: 1` unless the root genuinely should not
	 * fill the window.
	 */
	style?: StyleProp<ViewStyle>;
};

/**
 * Every provider this library needs at an app's root, in one component.
 *
 * Mount it ONCE, around everything — a root layout, an `App.tsx`. It is not
 * idempotent and does not detect an enclosing copy of itself; see AGENTS.md.
 *
 * Five layers, outermost first, and the order is not stylistic:
 *
 * 1. `GestureHandlerRootView` — an ancestor native view every gesture handler
 *    `Pressable` creates has to attach to. Its absence is silent: no error, no
 *    warning, presses simply stop landing.
 * 2. `SafeAreaProvider` — the insets `Screen`'s navbar, footer and scroll
 *    reserves are all computed from, seeded so the first frame is not blank.
 * 3. `KeyboardProvider` — the shared animation values `Screen.Footer` rides.
 * 4. `KeyboardStateSync` — a child of the keyboard provider, because it calls
 *    `useKeyboardContext()`. It repairs the one pair of animation values that
 *    provider shares with the whole app: on iOS they are written only from the
 *    `will` events, so a keyboard that vanishes without one — an interactive
 *    dismiss interrupted by navigation, a stack pop, an app suspend — leaves
 *    every screen in the app believing it is still open.
 * 5. `CalmMotionProvider` — the app's `isMotionCalm`, for `useCalmMotion()`.
 *    Pure context, no native view, so it wraps `{children}` alone — innermost,
 *    where a new layer goes.
 *
 * **`BottomSheetProvider` is not here, and the app mounts it.** The sheet's
 * engine, `@delacour/react-native-bottom-sheet`, is an optional peer of this
 * library: importing it from the recommended root would make every app resolve
 * it, sheet or no sheet. So the provider is exported from
 * `@/components/ui/bottom-sheet` and goes innermost, inside this and
 * around the navigator — it reads the gesture root for its pans, the safe area
 * for its insets and the keyboard values a sheet's footer rides, and it draws
 * above the app, so it wraps `{children}` and nothing else moves. That is what
 * a new layer here always looks like, one package along.
 *
 * `KeyboardStateSync` is a sibling of `{children}` rather than a wrapper. The
 * repair is global and has to run for the whole app's lifetime; inside a layer
 * that can remount it would be torn down with it.
 *
 * There are no per-layer escape hatches and no layer-named props on purpose.
 * An app that needs a different stack composes the providers by hand; they are
 * all public from their own packages, and this is a convenience, not a gate.
 *
 * @example
 * // expo-router root layout. The css import must stay the first statement.
 * import "../styles/global.css";
 * import { BottomSheetProvider } from "@/components/ui/bottom-sheet";
 * import { DelacourProvider } from "@/components/ui/provider";
 * import { Stack } from "expo-router";
 *
 * export default function RootLayout() {
 *   return (
 *     <DelacourProvider>
 *       <BottomSheetProvider>
 *         <Stack screenOptions={{ headerShown: false }} />
 *       </BottomSheetProvider>
 *     </DelacourProvider>
 *   );
 * }
 *
 * @example
 * // Measure the safe area from scratch, accepting the blank first frame — an
 * // app that launches into a rotated or split-screen window and cannot
 * // tolerate one stale frame.
 * <DelacourProvider initialMetrics={null}>{children}</DelacourProvider>
 *
 * @example
 * // An E2E build: decorative loops hold still so the test runner never waits
 * // out a shimmer. `IS_E2E` is the app's own build flag.
 * <DelacourProvider isMotionCalm={IS_E2E}>{children}</DelacourProvider>
 */
export function DelacourProvider({
	children,
	initialMetrics = initialWindowMetrics,
	isMotionCalm = false,
	style,
}: DelacourProviderProps): ReactElement {
	return (
		<GestureHandlerRootView style={style}>
			<SafeAreaProvider initialMetrics={initialMetrics}>
				<KeyboardProvider>
					<KeyboardStateSync />
					<CalmMotionProvider isMotionCalm={isMotionCalm}>{children}</CalmMotionProvider>
				</KeyboardProvider>
			</SafeAreaProvider>
		</GestureHandlerRootView>
	);
}
DelacourProvider.displayName = "DelacourUI.Provider";
