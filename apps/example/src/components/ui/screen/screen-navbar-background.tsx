import { memo, type ReactElement } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useScreenPart } from "./screen.context";
import { resolveNavbarBorderOpacity, screenVariants } from "./screen.variants";

export type ScreenNavbarBackgroundProps = {
	className?: string;
	/** Ramp the hairline in as the screen scrolls instead of drawing it at rest. */
	fadeOnScroll?: boolean;
};

/**
 * The navbar's opaque backing, and its bottom hairline.
 *
 * Separated from the navbar itself because it reads `scrollY`, which changes
 * every frame: memoised and isolated, the animated style re-runs on the UI
 * thread without the navbar's children re-rendering with it.
 *
 * The line is drawn at rest by default. `fadeOnScroll` ramps it in over the
 * first {@link SCREEN_BORDER_FADE_DISTANCE} points instead, for a header
 * that should read as undivided until the content moves.
 *
 * The fill is a CLASS rather than an inline style. An inline `backgroundColor`
 * beats the style uniwind resolves from a className, which is what would make a
 * caller's `backgroundClassName` silently inert.
 */
export const ScreenNavbarBackground = memo(function ScreenNavbarBackground({
	className,
	fadeOnScroll = false,
}: ScreenNavbarBackgroundProps): ReactElement {
	const { scrollY } = useScreenPart("Screen.Navbar");

	const borderStyle = useAnimatedStyle(
		() => ({ opacity: resolveNavbarBorderOpacity(scrollY.value, fadeOnScroll) }),
		[fadeOnScroll]
	);

	return (
		<View className={screenVariants().navbarBackground({ className })} pointerEvents="none">
			<Animated.View className={screenVariants().navbarBorder()} style={borderStyle} />
		</View>
	);
});
ScreenNavbarBackground.displayName = "DelacourUI.Screen.Navbar.Background";
