import { LinearGradient } from "expo-linear-gradient";
import type { ReactElement } from "react";
import { StyleSheet, View, type ViewProps } from "react-native";
import Animated, { interpolate, useAnimatedStyle } from "react-native-reanimated";
import { useThemeColor } from "@/hooks/use-theme-color";
import { transparentOf } from "@/lib/color";
import { useScreenPart } from "./screen.context";

/** How tall the fade is, in points, when a caller names no size. */
const SCROLL_SHADOW_SIZE = 28;
/**
 * How far the scrollable travels before a fade is fully in, as a share of `size`.
 *
 * A quarter, so the fade arrives while the first row is still leaving rather
 * than trailing it: matching the ramp to the fade's own height reads as the
 * shadow lagging the finger.
 */
const SCROLL_SHADOW_RAMP = 0.25;

/** Which ends of the scrollable fade. */
export const SCROLL_SHADOW_EDGES = ["top", "bottom", "both"] as const;
export type ScreenScrollShadowEdge = (typeof SCROLL_SHADOW_EDGES)[number];

/** What the fade measures its position from. */
export const SCROLL_SHADOW_ANCHORS = ["screen", "parent"] as const;
export type ScreenScrollShadowAnchor = (typeof SCROLL_SHADOW_ANCHORS)[number];

export type ScreenScrollShadowProps = Omit<ViewProps, "children" | "pointerEvents"> & {
	/** How tall the fade is, in points. @default SCROLL_SHADOW_SIZE */
	size?: number;
	/** Which ends fade. @default "both" */
	edges?: ScreenScrollShadowEdge;
	/**
	 * What the fade positions itself against.
	 *
	 * `screen` measures from the navbar and footer, which is right whenever this
	 * is a sibling of the body. `parent` pins it to its container instead, for a
	 * caller that has already placed it — chrome drawing this behind itself,
	 * because paint order is source order and nothing outside a navigator can
	 * slot between the pages it renders and the bar it renders over them.
	 *
	 * @default "screen"
	 */
	anchor?: ScreenScrollShadowAnchor;
	/**
	 * The colour the content fades into.
	 *
	 * Defaults to the `background` token, which is what a screen paints. Name
	 * another when the shadow sits over a different surface — a `card`, say —
	 * because a fade into the wrong colour reads as a grey band rather than as
	 * the content running out.
	 */
	color?: string;
	/**
	 * Points of SOLID colour above the gradient, for chrome floating over the body.
	 *
	 * Not an offset — the fade still begins at the navbar. This is the band the
	 * floating chrome occupies, painted opaque so content is already gone by the
	 * time it reaches the chrome, with the gradient below it doing the dissolving.
	 * Offsetting the fade past the chrome instead leaves content crisp behind
	 * whatever parts of it are transparent, and then cuts abruptly where the fade
	 * finally starts — which is the whole artefact this is here to avoid.
	 */
	coverTop?: number;
	/** Points of solid colour below the gradient, for chrome floating at the end. */
	coverBottom?: number;
	className?: string;
};

/**
 * A fade at each end of the screen's scrollable, for content that runs past it.
 *
 * The problem it solves is that a scrollable with a hard edge looks finished. A
 * row cut exactly in half by the bottom of the viewport reads as a layout bug;
 * the same row fading out reads as more to come. That signal matters most under
 * chrome that floats over the content, where the cut lands mid-component and
 * there is no bar edge to explain it.
 *
 * **It is a sibling of the scrollable, not a wrapper around it.** The screen
 * context already publishes `scrollY`, `contentHeight` and `layoutHeight` from
 * whichever body is mounted, so this reads the numbers rather than intercepting
 * them. Wrapping would mean cloning the child to attach an `onScroll`, and every
 * scrollable this package ships already has one of its own — the reserve
 * animations in `use-screen-scroll-insets` are driven by it — so a second writer
 * would take a handler that is already spoken for.
 *
 * It follows that this works over any of them: `ScrollArea`, `FlatList`,
 * `SectionList`, `LegendList` and `ChatList` all publish to the same context.
 *
 * **It places itself against the screen's own chrome.** The top fade starts at
 * the navbar's measured height and the bottom above the footer's, both read from
 * the same context, so it is correct under either placement without a caller
 * measuring anything.
 *
 * **`coverTop` extends the band, it does not move it.** Chrome floating between
 * the navbar and the body — a tab bar, say — wants the content already gone
 * where it passes behind, so the band is solid for those points and only then
 * begins to fade. Pushing the whole fade below the chrome instead leaves content
 * crisp behind whatever parts of it are transparent, and cuts abruptly where the
 * fade finally starts.
 *
 * **Each end fades only when there is something past it.** The top is out at
 * rest and arrives over the first `size` points of travel; the bottom is there
 * from the start and leaves over the last `size`. Content shorter than its
 * viewport never scrolls, so `maxScroll` is zero and both stay out — a fade over
 * a short page would be an edge that promises content that does not exist.
 *
 * **The far stop is the near colour at zero alpha, never `transparent`.** The
 * keyword is transparent BLACK, so interpolating toward it drags every stop
 * between through grey — a dark bloom over a light ground and a milky one over
 * a dark. `transparentOf` takes the alpha off the colour instead, and this
 * declines to draw at all rather than fall back to the keyword.
 *
 * @example
 * <Screen>
 *   <Screen.ScrollArea>{rows}</Screen.ScrollArea>
 *   <Screen.ScrollShadow />
 * </Screen>
 *
 * @example
 * // Under a bar floating over the content.
 * <Screen.ScrollShadow insetTop={barHeight} />
 */
export function ScreenScrollShadow({
	size = SCROLL_SHADOW_SIZE,
	edges = "both",
	anchor = "screen",
	color,
	coverTop = 0,
	coverBottom = 0,
	className,
	style,
	...props
}: ScreenScrollShadowProps): ReactElement {
	const { scrollY, contentHeight, layoutHeight, navbar, footer } = useScreenPart("Screen.ScrollShadow");
	const background = useThemeColor("background");
	const paint = color ?? background;
	const faded = transparentOf(paint);
	const ramp = size * SCROLL_SHADOW_RAMP;

	// The chrome's height is part of the position, not something a caller adds.
	// This fills the whole screen, so a fade placed at zero would sit behind the
	// navbar under a static one and under an overlay one alike — visible in
	// neither, which is a component that silently does nothing.
	const topStyle = useAnimatedStyle(() => ({
		opacity: interpolate(scrollY.value, [0, ramp], [0, 1], "clamp"),
		top: anchor === "parent" ? 0 : navbar.height.value,
	}));

	const bottomStyle = useAnimatedStyle(() => {
		const maxScroll = contentHeight.value - layoutHeight.value;
		const bottom = anchor === "parent" ? 0 : footer.height.value + footer.overlayHeight.value;
		if (maxScroll <= 0) return { bottom, opacity: 0 };

		return { bottom, opacity: interpolate(scrollY.value, [maxScroll - ramp, maxScroll], [1, 0], "clamp") };
	});

	// Without a colour to fade from there is no honest gradient to draw, and the
	// keyword `transparent` is not a substitute — see `transparentOf`.
	if (!(paint && faded)) return <View />;

	return (
		<View className={className} pointerEvents="none" style={[StyleSheet.absoluteFill, style]} {...props}>
			{edges === "bottom" ? null : (
				<Animated.View style={[{ height: coverTop + size, left: 0, position: "absolute", right: 0 }, topStyle]}>
					<LinearGradient
						colors={[paint, paint, faded]}
						locations={[0, coverTop / (coverTop + size), 1]}
						style={StyleSheet.absoluteFill}
					/>
				</Animated.View>
			)}

			{edges === "top" ? null : (
				<Animated.View style={[{ height: coverBottom + size, left: 0, position: "absolute", right: 0 }, bottomStyle]}>
					<LinearGradient
						colors={[faded, paint, paint]}
						locations={[0, size / (coverBottom + size), 1]}
						style={StyleSheet.absoluteFill}
					/>
				</Animated.View>
			)}
		</View>
	);
}
ScreenScrollShadow.displayName = "DelacourUI.Screen.ScrollShadow";
