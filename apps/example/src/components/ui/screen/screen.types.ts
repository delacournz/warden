import type { ReactNode } from "react";
import type { ScrollView, ViewProps } from "react-native";
import type { ScreenEdge, ScreenPlacement } from "./screen.variants";

/**
 * The instance `Screen.ScrollArea` hands back through its `ref`.
 *
 * Named rather than left inline because a caller needs to say it to declare the
 * ref in the first place — `useAnimatedRef<ScreenScrollViewRef>()` for a scroll
 * driven from the UI thread, `useRef<ScreenScrollViewRef>(null)` for one driven
 * from JS. Both reach the same `scrollTo`.
 *
 * React Native's own `ScrollView` instance, which is what both engines actually
 * hand back — `Animated.ScrollView` forwards to it, and
 * `KeyboardAwareScrollViewRef` is defined as that same instance plus one method.
 *
 * Not `ComponentRef<typeof Animated.ScrollView>`: Reanimated's animated
 * component types carry no `RefAttributes`, so that expression collapses to
 * `never` — which still compiles everywhere, silently accepts any ref, and
 * gives a caller a `.current` it can do nothing with.
 */
export type ScreenScrollViewRef = ScrollView;

/**
 * The shape of a container that can inset itself against the safe area.
 *
 * Shared by `Screen.Content` and `Screen.Header`, so it lives in a leaf rather
 * than in one of them arbitrarily.
 */
export type ScreenInsetProps = ViewProps & {
	/** Safe-area edges to pad against. None by default. */
	insets?: readonly ScreenEdge[];
	className?: string;
	children?: ReactNode;
};

/**
 * The shape of a part that either overlays the content or sits in the flow.
 *
 * Shared by `Screen.Navbar` and `Screen.Footer` — the two parts a scrollable
 * has to clear, and the reason `placement` is one axis rather than a boolean on
 * each of them.
 */
export type ScreenPlacementProps = ViewProps & {
	/**
	 * `overlay` floats the part over the content, which then insets itself by
	 * the measured height. `static` puts it in the flow, taking its own space.
	 */
	placement?: ScreenPlacement;
	className?: string;
	children?: ReactNode;
};

/**
 * What every Screen scrollable accepts on top of its own list props.
 *
 * `header` is separate from a list's `ListHeaderComponent` on purpose: the
 * screen composes its navbar spacer, this header and the caller's list header
 * in that order, so a caller can use both without having to interleave them.
 */
export type ScreenScrollableProps = {
	/** Rendered above the content, below the navbar spacer. */
	header?: ReactNode;
	className?: string;
	contentContainerClassName?: string;
};
