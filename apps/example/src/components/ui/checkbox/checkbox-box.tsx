import { type ReactElement, useCallback, useEffect } from "react";
import type { LayoutChangeEvent } from "react-native";
import Animated, {
	cancelAnimation,
	Extrapolation,
	interpolate,
	interpolateColor,
	useAnimatedStyle,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";
import { useCSSVariable } from "uniwind";
import { useThemeColor } from "@/hooks/use-theme-color";
import { IconCheckmark1Small, IconMinusSmall } from "@/lib/icons/central";
import { Icon } from "@/components/ui/icon";
import { useCheckboxPart } from "./checkbox.context";
import {
	CHECKBOX_BORDER_WIDTH,
	CHECKBOX_GLYPH_TOKEN,
	CHECKBOX_INDICATOR_ANIMATION,
	CHECKBOX_INVALID_GLYPH_TOKEN,
	checkboxVariants,
	resolveCheckboxBorderTokens,
	resolveCheckboxFilled,
	resolveCheckboxFillRadius,
} from "./checkbox.variants";

/**
 * The square itself: its border, the fill behind it and the tick drawn on top.
 *
 * Internal — the checkbox renders one and there is nothing for a caller to
 * compose here that `isIndeterminate` does not already decide. It takes a file
 * of its own because it owns every animated value; keeping them in the root
 * would make the root a component that changes for two unrelated reasons.
 *
 * Three things move, off one shared progress, so they cannot drift out of step:
 *
 * - the **fill** fades and scales from the centre. A box is filled, not slid
 *   into, so it arrives from no edge. Its corner radius is fixed rather than
 *   animated — {@link resolveCheckboxFillRadius} gives it the box's own corner at
 *   every scale, and the transform shrinks the rendered one with it. It spans the
 *   whole border box rather than the padding box, so it runs *under* the border
 *   ring instead of stopping against it; two coincident antialiased curves leave
 *   a seam at each corner, and there is no longer a shared edge to leave one.
 * - the **tick** is clipped by a container whose width opens from the left, so
 *   the stroke is drawn on when ticking and taken back when unticking rather
 *   than faded up in place.
 * - the **border** interpolates from the field chrome to the fill's own colour,
 *   held back by `borderDelay` until the surface is near the edge — so it reads
 *   as the fill arriving at the border rather than as an outline changing on its
 *   own. A colour being interpolated cannot be a class, which is why this one is
 *   the only part of the box a `tv()` does not describe.
 *
 * The clip needs the box's width in points, and a `size-checkbox-*` class cannot
 * be read from JavaScript. It comes from the box's own `onLayout` rather than a
 * table of numbers restating `tokens.css`, less its two borders — `onLayout`
 * reports the border box, and the clip is positioned in the padding box inside
 * it. The fill cannot be the thing measured: it deliberately overhangs.
 *
 * Reduce-motion takes Reanimated's default `System` policy here, deliberately
 * unlike `Spinner`. Under it `withTiming` completes instantly, which for a
 * checkbox is exactly right: the state change is the point and the travel is
 * decoration. A spinner had to opt out because its animation *is* the signal.
 */
export function CheckboxBox(): ReactElement {
	const { color, size, isChecked, isIndeterminate, isInvalid } = useCheckboxPart("Checkbox.Box");
	const isFilled = resolveCheckboxFilled({ isChecked, isIndeterminate });

	const progress = useSharedValue(isFilled ? 1 : 0);
	const boxWidth = useSharedValue(0);

	useEffect(() => {
		progress.value = withTiming(isFilled ? 1 : 0, { duration: CHECKBOX_INDICATOR_ANIMATION.durationMs });

		// Without this a box unmounted mid-toggle leaves its timing running.
		return () => cancelAnimation(progress);
	}, [isFilled, progress]);

	// Subtracting the border twice is what keeps the glyph on the box's centre
	// line. `tick` and `tickInner` are positioned in the padding box, so handing
	// them the border-box width moves the centre they resolve against.
	const handleLayout = useCallback(
		(event: LayoutChangeEvent) => {
			boxWidth.value = Math.max(0, event.nativeEvent.layout.width - 2 * CHECKBOX_BORDER_WIDTH);
		},
		[boxWidth]
	);

	// `--radius` is the only step of the corner scale that survives to runtime —
	// the rest are `@theme inline` and get substituted into their utilities — so
	// the fill's own corner is computed from the base rather than read back.
	const radius = (useCSSVariable("--radius") as number | undefined) ?? 0;
	const fillRadius = resolveCheckboxFillRadius(size, radius);

	const border = resolveCheckboxBorderTokens({ color, isInvalid });
	const restBorderColor = useThemeColor(border.rest) ?? "transparent";
	const activeBorderColor = useThemeColor(border.active) ?? "transparent";

	const boxStyle = useAnimatedStyle(() => ({
		borderColor: interpolateColor(
			interpolate(progress.value, [CHECKBOX_INDICATOR_ANIMATION.borderDelay, 1], [0, 1], Extrapolation.CLAMP),
			[0, 1],
			[restBorderColor, activeBorderColor]
		),
	}));

	const fillStyle = useAnimatedStyle(() => ({
		opacity: interpolate(progress.value, [0, 1], CHECKBOX_INDICATOR_ANIMATION.opacity),
		transform: [{ scale: interpolate(progress.value, [0, 1], CHECKBOX_INDICATOR_ANIMATION.scale) }],
	}));

	// Clamped, so the tick sits at zero width through the delay rather than being
	// extrapolated to a negative one.
	const tickStyle = useAnimatedStyle(() => ({
		width:
			boxWidth.value *
			interpolate(progress.value, [CHECKBOX_INDICATOR_ANIMATION.tickDelay, 1], [0, 1], Extrapolation.CLAMP),
	}));

	// Full width regardless of the clip in front of it, so the glyph stays on the
	// box's centre line while the clip opens instead of sliding across with it.
	const tickInnerStyle = useAnimatedStyle(() => ({ width: boxWidth.value }));

	const slots = checkboxVariants({ color, isFilled, isInvalid, size });
	// A colour that has to reach an SVG paint prop cannot be a class. See Theming.
	const glyphColor = useThemeColor(isInvalid ? CHECKBOX_INVALID_GLYPH_TOKEN : CHECKBOX_GLYPH_TOKEN[color]);

	return (
		<Animated.View className={slots.box()} onLayout={handleLayout} style={boxStyle}>
			<Animated.View
				className={slots.indicator()}
				// A fixed radius rather than an animated one: the fill wears the box's
				// own corner, and that value does not change while the box is growing.
				// `scale` shrinks the rendered corner along with the square, which is
				// what keeps a half-grown fill looking like a smaller version of the
				// finished one. It is read from `--radius` rather than written down
				// because a consumer's theme is allowed to retune that.
				style={[{ borderRadius: fillRadius }, fillStyle]}
			/>
			<Animated.View className={slots.tick()} style={tickStyle}>
				<Animated.View className={slots.tickInner()} style={tickInnerStyle}>
					<Icon
						className={slots.glyph()}
						color={glyphColor}
						icon={isIndeterminate ? IconMinusSmall : IconCheckmark1Small}
					/>
				</Animated.View>
			</Animated.View>
		</Animated.View>
	);
}
CheckboxBox.displayName = "DelacourUI.Checkbox.Box";
