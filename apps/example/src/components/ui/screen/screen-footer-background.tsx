import { memo, type ReactElement } from "react";
import { View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useScreenDebug, useScreenPart } from "./screen.context";
import { resolveFooterBorderOpacity, type ScreenPlacement, screenVariants } from "./screen.variants";
import { SCREEN_DEBUG_COLORS } from "./screen-debug";

export type ScreenFooterBackgroundProps = {
	placement: ScreenPlacement;
	/** Fade the top hairline out as the content runs out, instead of drawing it at rest. */
	fadeOnScroll?: boolean;
};

/**
 * The footer's backing and its top hairline.
 *
 * Both are opaque only when the footer is `static`. A static footer is chrome:
 * it takes its own space, and the content above must not show through when the
 * keyboard lifts it. An `overlay` footer floats over content that deliberately
 * scrolls under it, so it gets neither.
 *
 * Rendered INSIDE `KeyboardStickyView` so it travels with the translation. On
 * the positioned outer view it would stay behind while the buttons moved.
 *
 * Separated from the footer itself because it reads `scrollY`, which changes
 * every frame: memoised and isolated, the animated style re-runs on the UI
 * thread without the footer's children re-rendering with it — the same reason
 * `ScreenNavbarBackground` is its own component.
 */
export const ScreenFooterBackground = memo(function ScreenFooterBackground({
	placement,
	fadeOnScroll = false,
}: ScreenFooterBackgroundProps): ReactElement {
	const { scrollY, contentHeight, layoutHeight } = useScreenPart("Screen.Footer");
	const debug = useScreenDebug();
	const slots = screenVariants({ placement });

	const borderStyle = useAnimatedStyle(
		() => ({
			opacity: resolveFooterBorderOpacity({
				contentHeight: contentHeight.value,
				fadeOnScroll,
				layoutHeight: layoutHeight.value,
				scrollY: scrollY.value,
			}),
		}),
		[fadeOnScroll]
	);

	return (
		<View
			className={slots.footerBackground()}
			pointerEvents="none"
			style={debug ? { backgroundColor: SCREEN_DEBUG_COLORS.footerSticky } : undefined}
		>
			<Animated.View className={slots.footerBorder()} style={borderStyle} />
		</View>
	);
});
ScreenFooterBackground.displayName = "DelacourUI.Screen.Footer.Background";
