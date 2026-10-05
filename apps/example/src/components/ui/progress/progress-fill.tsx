import { type ReactElement, useEffect } from "react";
import type { ViewProps } from "react-native";
import Animated, {
	cancelAnimation,
	Easing,
	ReduceMotion,
	useAnimatedStyle,
	useReducedMotion,
	useSharedValue,
	withRepeat,
	withTiming,
} from "react-native-reanimated";
import { useProgressPart } from "./progress.context";
import {
	fillTranslate,
	indeterminateSegment,
	PROGRESS_FILL_DURATION_MS,
	PROGRESS_INDETERMINATE_DURATION_MS,
	PROGRESS_INDETERMINATE_SEGMENT,
	PROGRESS_PULSE,
	progressVariants,
} from "./progress.variants";

export type ProgressFillProps = Omit<ViewProps, "children" | "style"> & {
	className?: string;
};

/**
 * The painted bar.
 *
 * **Everything it animates runs on the UI thread.** A new value is handed to
 * `withTiming` once, from an effect, and the frames that follow never touch
 * React — so an upload reporting ten times a second costs ten renders, not six
 * hundred.
 *
 * **Determinate, it is a full-length bar parked left of the track** by what is
 * still to go, and a `translateX` slides it in. A transform composites without a
 * layout pass; an animated `width` would re-lay the bar out on every frame. The
 * track clips what is parked.
 *
 * **Indeterminate, it is a segment sweeping across**, from wholly off the left
 * edge to wholly off the right, so the loop's seam is never on screen. With the
 * system's reduce-motion setting on, the sweep becomes the whole track breathing
 * between two opacities instead: still visibly alive — which a status indicator
 * must be, the same reasoning `Spinner` gives for opting out of the policy — but
 * with nothing travelling across the screen.
 *
 * It is hidden until the track has been measured. A fill positioned against a
 * width of 0 would flash at full length for the frame before layout lands.
 */
export function ProgressFill({ className, ...props }: ProgressFillProps): ReactElement {
	const { ratio, isIndeterminate, color, size, trackSize } = useProgressPart("Progress.Fill");
	const isReducedMotion = useReducedMotion();

	// Seeded at the current ratio, so a bar that mounts at 60% is drawn at 60%
	// rather than animating up from nothing every time a list row scrolls in.
	const progress = useSharedValue(ratio);
	const phase = useSharedValue(0);
	const pulse = useSharedValue<number>(PROGRESS_PULSE.to);

	useEffect(() => {
		if (isIndeterminate) return;
		progress.value = withTiming(ratio, {
			duration: PROGRESS_FILL_DURATION_MS,
			easing: Easing.out(Easing.cubic),
		});
	}, [isIndeterminate, progress, ratio]);

	useEffect(() => {
		if (!isIndeterminate) return;

		if (isReducedMotion) {
			pulse.value = PROGRESS_PULSE.to;
			pulse.value = withRepeat(
				withTiming(PROGRESS_PULSE.from, {
					duration: PROGRESS_PULSE.durationMs,
					easing: Easing.inOut(Easing.ease),
					// Under the default `System` policy the timing completes instantly
					// while reduce motion is on, and `withRepeat(-1)` would spin a
					// zero-length animation forever — a frozen bar, which reads as hung.
					reduceMotion: ReduceMotion.Never,
				}),
				-1,
				true,
				undefined,
				// The repeat has a reduce-motion policy of its own, separate from the
				// timing's. Left at `System`, it declines to start a reversing loop at
				// all and stops a forward one after a single pass.
				ReduceMotion.Never
			);
		} else {
			phase.value = 0;
			phase.value = withRepeat(
				withTiming(1, {
					duration: PROGRESS_INDETERMINATE_DURATION_MS,
					easing: Easing.inOut(Easing.ease),
					reduceMotion: ReduceMotion.Never,
				}),
				-1,
				false,
				undefined,
				ReduceMotion.Never
			);
		}

		// Without this the repeat outlives the bar, or the switch back to a value.
		return () => {
			cancelAnimation(phase);
			cancelAnimation(pulse);
			pulse.value = PROGRESS_PULSE.to;
		};
	}, [isIndeterminate, isReducedMotion, phase, pulse]);

	const fillStyle = useAnimatedStyle(() => {
		const track = trackSize.value;
		const isMeasured = track > 0;

		// The same keys every frame, so Reanimated is never asked to swap a style's
		// shape when the bar flips between modes.
		if (isIndeterminate && !isReducedMotion) {
			const segment = indeterminateSegment({
				phase: phase.value,
				segment: PROGRESS_INDETERMINATE_SEGMENT,
				trackSize: track,
			});
			return {
				opacity: isMeasured ? 1 : 0,
				transform: [{ translateX: segment.translate }],
				width: segment.width,
			};
		}

		if (isIndeterminate) {
			return { opacity: isMeasured ? pulse.value : 0, transform: [{ translateX: 0 }], width: track };
		}

		return {
			opacity: isMeasured ? 1 : 0,
			transform: [{ translateX: fillTranslate({ ratio: progress.value, trackSize: track }) }],
			width: track,
		};
	});

	return (
		<Animated.View
			className={progressVariants({ color, isIndeterminate, size }).fill({ className })}
			style={fillStyle}
			{...props}
		/>
	);
}
ProgressFill.displayName = "DelacourUI.Progress.Fill";
