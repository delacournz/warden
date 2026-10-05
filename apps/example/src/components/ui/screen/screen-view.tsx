import type { ReactElement, ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useScreenPart } from "./screen.context";
import { resolveScreenViewPadding, screenVariants } from "./screen.variants";

export type ScreenViewProps = ViewProps & {
	className?: string;
	children?: ReactNode;
};

/**
 * A non-scrolling container that keeps its content clear of the screen's chrome.
 *
 * Two nested boxes, and the split is the whole point: the measured chrome
 * clearance is an inline style on the OUTER one, the caller's `className` and
 * `style` go on the inner one. On a single box they would not stack — uniwind
 * puts a class's style first and the `style` prop second, and Yoga resolves a
 * longhand `paddingTop` ahead of the `padding` a class compiles to — so
 * `<Screen.View className="p-5">` kept its left and right padding and silently
 * lost its top and bottom. Nested, they add, which is what a caller means.
 *
 * The padding is an animated style rather than a class because both numbers are
 * measured at runtime — an overlay navbar and footer publish their heights into
 * the screen context, and reading them on the UI thread means the padding lands
 * in the same frame as the measurement instead of a re-render later.
 *
 * With nothing mounted on an edge it falls back to the raw safe-area inset, so
 * a screen with no navbar still clears the notch. A `static` navbar or footer
 * contributes nothing here: it already took its space in the flow.
 *
 * Use `Screen.ScrollArea` when the content can overflow — this one cannot
 * scroll, so content taller than the viewport is simply clipped.
 */
export function ScreenView({ className, style, children, ...props }: ScreenViewProps): ReactElement {
	const { navbar, footer } = useScreenPart("Screen.View");
	const { top, bottom } = useSafeAreaInsets();

	const animatedStyle = useAnimatedStyle(() => {
		return resolveScreenViewPadding({
			footerHeight: footer.height.value,
			footerPlacement: footer.placement.value,
			navbarHeight: navbar.height.value,
			navbarPlacement: navbar.placement.value,
			safeAreaBottom: bottom,
			safeAreaTop: top,
		});
	}, [top, bottom]);

	return (
		<Animated.View className="flex-1" style={animatedStyle}>
			<View className={screenVariants().view({ className })} style={style} {...props}>
				{children}
			</View>
		</Animated.View>
	);
}
ScreenView.displayName = "DelacourUI.Screen.View";
