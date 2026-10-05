import {
	Children,
	type ComponentRef,
	type ComponentType,
	createElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
	type Ref,
	useMemo,
} from "react";
import type { AccessibilityState, ViewProps } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { Presets } from "react-native-pulsar";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useResolveClassNames } from "uniwind";
import { composeRefs } from "@/lib/compose-refs";
import { mergeProps } from "@/lib/merge-props";
import { type PressableFeedback, resolvePressedState, resolveRestOpacity } from "./pressable.variants";

const PRESS_SPRING = { damping: 18, mass: 0.4, stiffness: 320 } as const;

/**
 * Animated counterpart of each component type seen by `asChild`.
 *
 * `Animated.createAnimatedComponent` must be called once per type, never per
 * render — a fresh wrapper each render remounts the subtree.
 */
const animatedTypeCache = new WeakMap<object, ComponentType<Record<string, unknown>>>();

function resolveAnimatedType(type: unknown): ComponentType<Record<string, unknown>> {
	if (typeof type !== "function" && typeof type !== "object") {
		throw new Error("Pressable asChild expects a component element, not an intrinsic or text node.");
	}

	const key = type as object;
	const cached = animatedTypeCache.get(key);
	if (cached) return cached;

	const created = Animated.createAnimatedComponent(type as ComponentType<Record<string, unknown>>) as ComponentType<
		Record<string, unknown>
	>;
	animatedTypeCache.set(key, created);
	return created;
}

export type HapticFeedback = "selection" | "light" | "medium" | "heavy" | "success" | "warning" | "error";

/**
 * Fires a haptic preset from the UI thread.
 *
 * Every branch is a worklet, so this runs inside the gesture callback itself —
 * the tap and the haptic land in the same frame rather than waiting on a round
 * trip to the JS thread.
 *
 * Exported because it is the library's *only* haptic vocabulary, and a second
 * component with a gesture of its own — `Slider`, whose pan ticks as the value
 * crosses a step — must reach this switch rather than fork one. It is safe to
 * import across a component folder: nothing in `pressable/` imports a component
 * that could import it back, so there is no cycle for Metro to serve half of.
 */
export function playHaptic(feedback: HapticFeedback): void {
	"worklet";
	switch (feedback) {
		case "selection":
			Presets.System.selection();
			return;
		case "light":
			Presets.System.impactLight();
			return;
		case "medium":
			Presets.System.impactMedium();
			return;
		case "heavy":
			Presets.System.impactHeavy();
			return;
		case "success":
			Presets.System.notificationSuccess();
			return;
		case "warning":
			Presets.System.notificationWarning();
			return;
		case "error":
			Presets.System.notificationError();
			return;
		default:
			return;
	}
}

export type PressableProps = Omit<ViewProps, "style"> & {
	children?: ReactNode;
	className?: string;
	disabled?: boolean;
	/**
	 * Work is in flight: presses are blocked and a screen reader announces the
	 * element as busy, but not as disabled. Use this over `disabled` for a
	 * temporary state the component clears itself, so assistive tech reports a
	 * control that is momentarily unavailable rather than one that is inert.
	 */
	busy?: boolean;
	onPress?: () => void;
	onLongPress?: () => void;
	/** Haptic played on press-in. Off by default. */
	haptic?: false | HapticFeedback;
	/**
	 * How the press moves the element: `scale`, `fade`, `scale-fade` or `none`.
	 * `pressedScale` / `pressedOpacity` still win on the axis they name.
	 */
	feedback?: PressableFeedback;
	/** Scale at full press. 1 disables the scale. Overrides `feedback`. */
	pressedScale?: number;
	/** Opacity at full press. 1 disables the fade. Overrides `feedback`. */
	pressedOpacity?: number;
	/** Render into the single child element instead of emitting a View. */
	asChild?: boolean;
	ref?: Ref<ComponentRef<typeof Animated.View>>;
};

/**
 * The interaction primitive every pressable component in this library builds on.
 *
 * Press feedback runs entirely on the UI thread: a Gesture Handler tap drives a
 * shared value, a spring maps it to scale and opacity, and the haptic fires in
 * the same worklet. Only `onPress` and `onLongPress` cross back to JS.
 *
 * How far each axis travels comes from `feedback`, the named vocabulary every
 * pressable in this library shares, or from `pressedScale` / `pressedOpacity`
 * for a value the named modes do not cover.
 *
 * Built on the Gesture API rather than a ready-made pressable so the animation,
 * the haptic and the gesture stay on one thread, and so nothing depends on
 * Gesture Handler's own `Pressable`, which was renamed in its v3.
 */
export function Pressable({
	children,
	className,
	disabled = false,
	busy = false,
	onPress,
	onLongPress,
	haptic = false,
	feedback,
	pressedScale,
	pressedOpacity,
	asChild = false,
	accessibilityState,
	ref,
	...props
}: PressableProps): ReactElement {
	const pressed = useSharedValue(0);
	const interactive = !disabled && !busy;
	// Destructured to primitives on purpose. Reanimated's plugin collects what
	// the worklet closes over, and a fresh object each render would rebuild the
	// animated style every render.
	const { opacity: targetOpacity, scale: targetScale } = resolvePressedState(feedback, pressedScale, pressedOpacity);
	// The animated style below owns `opacity` on the view, so a className's own
	// opacity — a disabled variant's `opacity-50` — is read here and multiplied
	// in rather than overwritten by the resting 1. See `resolveRestOpacity`.
	const restOpacity = resolveRestOpacity(useResolveClassNames(className ?? "").opacity);

	const gesture = useMemo(() => {
		const tap = Gesture.Tap()
			.enabled(interactive)
			.shouldCancelWhenOutside(true)
			.onBegin(() => {
				"worklet";
				pressed.value = withSpring(1, PRESS_SPRING);
				if (haptic) playHaptic(haptic);
			})
			.onEnd(() => {
				"worklet";
				if (onPress) scheduleOnRN(onPress);
			})
			.onFinalize(() => {
				"worklet";
				pressed.value = withSpring(0, PRESS_SPRING);
			});

		if (!onLongPress) return tap;

		const longPress = Gesture.LongPress()
			.enabled(interactive)
			.shouldCancelWhenOutside(true)
			.onStart(() => {
				"worklet";
				scheduleOnRN(onLongPress);
			});

		return Gesture.Simultaneous(tap, longPress);
	}, [haptic, interactive, onLongPress, onPress, pressed]);

	const animatedStyle = useAnimatedStyle(() => ({
		opacity: restOpacity * (1 - pressed.value * (1 - targetOpacity)),
		transform: [{ scale: 1 - pressed.value * (1 - targetScale) }],
	}));

	// Built once and spread at both render sites: a caller-supplied
	// `accessibilityState` merges into it rather than being clobbered by the
	// `{...props}` spread that lands after it.
	const state: AccessibilityState = { ...accessibilityState, busy, disabled };

	const content = asChild ? (
		renderAsChild(children, {
			accessibilityState: state,
			accessible: true,
			className,
			ref,
			style: animatedStyle,
			...props,
		})
	) : (
		<Animated.View
			accessibilityRole="button"
			accessibilityState={state}
			// Without this the view is not an accessibility element on iOS, and the
			// role, state and label above never reach VoiceOver — a composed label
			// on an icon-sized button included. It also merges the children into one
			// element, which is what a control should be.
			accessible
			className={className}
			ref={ref}
			style={animatedStyle}
			{...props}
		>
			{children}
		</Animated.View>
	);

	return <GestureDetector gesture={gesture}>{content}</GestureDetector>;
}
Pressable.displayName = "DelacourUI.Pressable";

/**
 * Renders the pressable's props into its single child, with no wrapper element.
 *
 * The child is rendered through the animated counterpart of its own type rather
 * than cloned as-is. A Reanimated style handed to a plain component is deep
 * frozen by React Native in development, and Reanimated's own effect then fails
 * writing to it — so the element receiving the style has to be an animated one.
 */
function renderAsChild(children: ReactNode, slotProps: Record<string, unknown>): ReactElement {
	const count = Children.count(children);
	if (count !== 1) {
		throw new Error(
			`Pressable asChild expects exactly one child element, received ${count}. Drop \`asChild\` to render a View.`
		);
	}

	const child = Children.only(children);
	if (!isValidElement(child)) {
		throw new Error("Pressable asChild expects a single React element child; text and fragments cannot take props.");
	}

	const childProps = child.props as Record<string, unknown> & { ref?: Ref<unknown> };
	const merged = mergeProps<Record<string, unknown>>(slotProps, childProps);
	merged.ref = composeRefs(slotProps.ref as Ref<unknown> | undefined, childProps.ref);

	return createElement(resolveAnimatedType(child.type), merged);
}
