import { type ComponentProps, type ReactElement, type ReactNode, useEffect } from "react";
import Animated, {
	cancelAnimation,
	Easing,
	ReduceMotion,
	useAnimatedStyle,
	useSharedValue,
	withRepeat,
	withTiming,
} from "react-native-reanimated";
import { useSpinner } from "./spinner.context";
import { SPINNER_DURATION_MS, spinnerVariants } from "./spinner.variants";
import { SpinnerArc } from "./spinner-arc";

export type SpinnerContentProps = Omit<ComponentProps<typeof Animated.View>, "children"> & {
	className?: string;
	children?: ReactNode;
};

/**
 * The rotating layer of a spinner.
 *
 * This is the part that turns, so a custom glyph or asset has to sit inside one
 * to spin. The spinner wraps a bare child in it automatically, which leaves
 * writing it out by hand for when the rotating layer itself needs styling.
 *
 * Colour and speed come from the spinner's context, and it fills the root
 * rather than taking a size — there is nothing to pass down to it.
 */
export function SpinnerContent({ className, style, children, ...props }: SpinnerContentProps): ReactElement {
	const { speed } = useSpinner();
	const angle = useSharedValue(0);

	useEffect(() => {
		angle.value = withRepeat(
			withTiming(360, {
				duration: SPINNER_DURATION_MS / speed,
				easing: Easing.linear,
				// Deliberate. Under the default `System` policy `withTiming` completes
				// instantly while the OS reduce-motion setting is on, so `withRepeat(-1)`
				// would spin a zero-length animation forever. A status indicator is not
				// decorative motion — it is the only thing saying work is in flight.
				reduceMotion: ReduceMotion.Never,
			}),
			-1,
			false
		);

		// Without this the repeat outlives the unmount when a button stops loading.
		return () => cancelAnimation(angle);
	}, [angle, speed]);

	const animatedStyle = useAnimatedStyle(() => ({
		transform: [{ rotate: `${angle.value}deg` }],
	}));

	return (
		<Animated.View className={spinnerVariants().content({ className })} style={[animatedStyle, style]} {...props}>
			{children ?? <SpinnerArc />}
		</Animated.View>
	);
}
SpinnerContent.displayName = "DelacourUI.Spinner.Content";
