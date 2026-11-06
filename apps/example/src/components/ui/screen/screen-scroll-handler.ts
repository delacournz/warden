import type { NativeScrollEvent, NativeSyntheticEvent } from "react-native";

/** A caller's `onScroll`, as React Native types it. */
export type ScreenScrollCallback = (event: NativeSyntheticEvent<NativeScrollEvent>) => void;

/**
 * What a caller handed a Screen scrollable as `onScroll`.
 *
 * Two shapes reach the same prop and need different plumbing. A
 * `useAnimatedScrollHandler` result is typed as a function but is really an
 * object carrying a `workletEventHandler`, and it composes with the screen's own
 * tracking on the UI thread. A plain function has to be called back on the JS
 * thread instead — Reanimated replaces the JS listener with a no-op once a
 * worklet handler owns the prop, so passing it through would drop it.
 */
export type ScreenScrollHandler =
	| { kind: "none" }
	| { kind: "js"; handler: ScreenScrollCallback }
	| { kind: "worklet"; handler: object };

/**
 * Sorts a caller's `onScroll` into the shape the scroll hook can compose.
 *
 * Structural rather than `instanceof WorkletEventHandler`: the class is
 * Reanimated-internal, and the property is what `useComposedEventHandler` reads.
 */
export function classifyScrollHandler(value: unknown): ScreenScrollHandler {
	if (typeof value === "function") return { handler: value as ScreenScrollCallback, kind: "js" };
	if (typeof value === "object" && value !== null && "workletEventHandler" in value) {
		return { handler: value, kind: "worklet" };
	}
	return { kind: "none" };
}
