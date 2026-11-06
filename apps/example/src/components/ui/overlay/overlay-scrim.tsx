import type { ReactElement } from "react";
import { Pressable, type PressableProps } from "react-native";
import Animated, { type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { overlayVariants } from "./overlay.variants";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export type OverlayScrimProps = Omit<PressableProps, "style" | "children" | "onPress"> & {
	/** The 0 → 1 presence progress from `useOverlayPresence`; the scrim's opacity follows it. */
	progress: SharedValue<number>;
	/**
	 * Called on a tap. Omit it and the scrim still takes the touch — the app
	 * under a non-dismissible overlay must not be pressable — but does nothing.
	 */
	onDismiss?: () => void;
	className?: string;
};

/**
 * The dim layer between the app and a modal overlay.
 *
 * `bg-overlay` at opacity 1 — the token carries its own alpha — faded in and
 * out by presence. Written before the panel in the same portal, so view order
 * gives a touch on the panel to the panel.
 *
 * Invisible to assistive technology. A scrim is not a control a screen reader
 * user can find; they dismiss through the panel's `onAccessibilityEscape` and
 * the back button instead.
 *
 * React Native's own `Pressable`, not this library's: it needs no feedback, no
 * haptic and no gesture handler — a gesture-handler tap here would race the
 * panel's own pans for the touch.
 */
export function OverlayScrim({ progress, onDismiss, className, ...props }: OverlayScrimProps): ReactElement {
	const fade = useAnimatedStyle(() => ({ opacity: progress.value }));

	return (
		<AnimatedPressable
			accessibilityElementsHidden
			accessible={false}
			className={overlayVariants().scrim({ className })}
			importantForAccessibility="no-hide-descendants"
			onPress={onDismiss}
			style={fade}
			{...props}
		/>
	);
}
OverlayScrim.displayName = "DelacourUI.Overlay.Scrim";
