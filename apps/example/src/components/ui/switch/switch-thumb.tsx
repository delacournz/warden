import { type ReactElement, type ReactNode, useCallback, useMemo } from "react";
import type { LayoutChangeEvent, ViewProps } from "react-native";
import Animated, { interpolateColor, useAnimatedStyle } from "react-native-reanimated";
import { useThemeColor } from "@/hooks/use-theme-color";
import { IconDefaultsProvider } from "@/components/ui/icon";
import { useSwitchPart } from "./switch.context";
import {
	resolveSwitchThumbTokens,
	resolveSwitchTrackTokens,
	SWITCH_THUMB_INSET,
	switchTravel,
	switchVariants,
} from "./switch.variants";

export type SwitchThumbProps = Omit<ViewProps, "children" | "style"> & {
	className?: string;
	/** Drawn inside the knob. An `Icon` needs nothing said at the call site. */
	children?: ReactNode;
};

/**
 * The knob that slides between the two ends of the track.
 *
 * Composed in automatically when the children hold none, so `<Switch />` is
 * already a complete control — `Radio`'s rule for its indicator. Write it out by
 * hand only to restyle it, or to put a glyph inside it.
 *
 * **It holds no gesture of its own.** One `Gesture.Pan()` on the root drives it,
 * because a touch anywhere on the pill should move the knob it is about to
 * move — and a gesture here would nest a descendant recogniser inside the root's,
 * leaving two to negotiate for one drag. `Slider.Thumb` makes the same trade for
 * the same reason.
 *
 * **One animated style, one node.** The position and the colour are entries in a
 * single `useAnimatedStyle`, because two calls on one view fight for the same
 * props and the later one silently wins — the rule `Radio.Indicator` states.
 *
 * **The colour is not a class.** It fades between two token *values* as the
 * switch travels, and a colour being interpolated cannot be a class — the rule
 * `Checkbox`'s border already follows. The `thumb` slot keeps `bg-background` as
 * the resting appearance this style starts from, and nothing else names a
 * background; two sources for one surface is how a class and a style end up
 * disagreeing for a frame on every toggle.
 *
 * **It is invisible until both layouts have reported.** The travel is measured,
 * not tabulated — `size-icon-xl` cannot be read from JavaScript — and a knob
 * drawn before then sits at a garbage offset for a frame, which reads as a
 * flicker on every mount.
 *
 * **It does not scale when grabbed, and the track does instead.** The track
 * clips, so a scaled knob would be cut off by its own capsule — a bite taken out
 * of the knob rather than an acknowledgement of the press. The outermost node is
 * the one thing nothing can crop, so that is where the press feedback lives.
 */
export function SwitchThumb({ className, children, ...props }: SwitchThumbProps): ReactElement {
	const { color, size, isInvalid, isDisabled, progress, trackWidth, thumbWidth } = useSwitchPart("Switch.Thumb");

	const handleLayout = useCallback(
		(event: LayoutChangeEvent) => {
			thumbWidth.value = event.nativeEvent.layout.width;
		},
		[thumbWidth]
	);

	const tokens = resolveSwitchThumbTokens({ color, isInvalid });
	const restColor = useThemeColor(tokens.rest) ?? "transparent";
	const activeColor = useThemeColor(tokens.active) ?? "transparent";

	const thumbStyle = useAnimatedStyle(() => {
		const measured = trackWidth.value;
		const travel = switchTravel({
			inset: SWITCH_THUMB_INSET,
			thumbWidth: thumbWidth.value,
			trackWidth: measured,
		});

		return {
			backgroundColor: interpolateColor(progress.value, [0, 1], [restColor, activeColor]),
			opacity: measured > 0 ? 1 : 0,
			transform: [{ translateX: progress.value * travel }],
		};
	});

	// A glyph on the knob takes the *track*'s colour, not the knob's own: it is
	// drawn on the knob, so it has to contrast with it, and the one value that
	// reads at both ends is the colour the track fades to. Static rather than
	// interpolated because an `Icon`'s colour is a prop, not a style.
	const slots = switchVariants({ isDisabled, size });
	const glyphColor = useThemeColor(resolveSwitchTrackTokens({ color, isInvalid }).active);
	const glyphClassName = slots.glyph();
	const iconDefaults = useMemo(
		() => ({ className: glyphClassName, color: glyphColor ?? "" }),
		[glyphClassName, glyphColor]
	);

	return (
		<Animated.View className={slots.thumb({ className })} onLayout={handleLayout} style={thumbStyle} {...props}>
			{children ? <IconDefaultsProvider value={iconDefaults}>{children}</IconDefaultsProvider> : null}
		</Animated.View>
	);
}
SwitchThumb.displayName = "DelacourUI.Switch.Thumb";
