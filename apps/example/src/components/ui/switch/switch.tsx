import {
	Children,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { AccessibilityActionEvent, LayoutChangeEvent, ViewProps } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
	cancelAnimation,
	interpolateColor,
	useAnimatedStyle,
	useSharedValue,
	withSpring,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useControllableState } from "@/hooks/use-controllable-state";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useFieldContext } from "@/components/ui/field/field.context";
import { type HapticFeedback, playHaptic } from "@/components/ui/pressable";
import { type SwitchContextValue, SwitchProvider } from "./switch.context";
import {
	hasThumbChild,
	resolveSwitchAxes,
	resolveSwitchRelease,
	resolveSwitchTrackTokens,
	SWITCH_PRESS_ANIMATION,
	SWITCH_PRESS_SPRING,
	SWITCH_THUMB_INSET,
	SWITCH_THUMB_SPRING,
	type SwitchColor,
	type SwitchSize,
	switchTravel,
	switchVariants,
} from "./switch.variants";
import { SwitchEndContent } from "./switch-end-content";
import { SwitchStartContent } from "./switch-start-content";
import { SwitchThumb } from "./switch-thumb";

export type SwitchProps = Omit<ViewProps, "children" | "style"> & {
	/** Controlled state. Pass nothing and the switch holds its own. */
	isSelected?: boolean;
	/** Starting state while uncontrolled. */
	defaultSelected?: boolean;
	onSelectedChange?: (isSelected: boolean) => void;
	/** What a switch that is on means. */
	color?: SwitchColor;
	size?: SwitchSize;
	/** Blocks the gesture and fades the control. Inherited from an enclosing `Field`. */
	isDisabled?: boolean;
	/** Reports an invalid value. Inherited from an enclosing `Field`. */
	isInvalid?: boolean;
	/** Played when a press or a drag actually flips it. `false` silences it. */
	haptic?: false | HapticFeedback;
	className?: string;
	children?: ReactNode;
};

function SwitchRoot({
	isSelected,
	defaultSelected = false,
	onSelectedChange,
	color,
	size,
	isDisabled,
	isInvalid,
	haptic = "selection",
	className,
	children,
	...props
}: SwitchProps): ReactElement {
	const field = useFieldContext();
	const axes = resolveSwitchAxes({ field, own: { color, isDisabled, isInvalid, size } });

	const [selected, setSelected] = useControllableState({
		defaultValue: defaultSelected,
		onChange: onSelectedChange,
		value: isSelected,
	});

	// Seeded from the current state rather than from zero, so a switch mounted on
	// does not slide its thumb across on its first paint.
	const progress = useSharedValue(selected ? 1 : 0);
	const trackWidth = useSharedValue(0);
	const thumbWidth = useSharedValue(0);
	// Where the thumb was when the finger landed, so a drag is relative to the
	// grab rather than to the leading edge — picking up a half-travelled thumb
	// mid-spring does not snap it to the finger.
	const grabbed = useSharedValue(0);
	// Whether a finger is down, driving the track's press scale. A shared value
	// rather than state: nothing renders differently for it, so a commit on every
	// touch would be pure cost.
	const isPressed = useSharedValue(0);

	// A ref rather than state: the pan reads it twice a drag and nothing renders
	// differently for it, so a re-render on touch-down would be pure cost.
	const isDragging = useRef(false);
	// Bumped on every release, purely to make the sync effect below run again.
	const [settledDrags, setSettledDrags] = useState(0);

	// `settledDrags` is not read in the body — being unread is the whole point of
	// it. A controlled parent that *rejects* a dragged value leaves `selected`
	// unchanged, so without a token that moves on every release there is nothing
	// to re-run on, and the thumb stays where the finger let go rather than
	// springing back to the state the parent actually holds.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the extra dependency is the re-run trigger, see above
	useEffect(() => {
		if (isDragging.current) return;
		progress.value = withSpring(selected ? 1 : 0, SWITCH_THUMB_SPRING);

		// Without this a switch unmounted mid-travel leaves its spring running.
		return () => cancelAnimation(progress);
	}, [progress, selected, settledDrags]);

	const setDragging = useCallback((dragging: boolean) => {
		isDragging.current = dragging;
	}, []);

	const selectedRef = useRef(selected);
	selectedRef.current = selected;

	const commit = useCallback(
		(next: boolean) => {
			setSettledDrags((count) => count + 1);
			if (next !== selectedRef.current) setSelected(next);
		},
		[setSelected]
	);

	const handleLayout = useCallback(
		(event: LayoutChangeEvent) => {
			trackWidth.value = event.nativeEvent.layout.width;
		},
		[trackWidth]
	);

	const gesture = useMemo(
		() =>
			Gesture.Pan()
				.enabled(!axes.isDisabled)
				.minDistance(0)
				.shouldCancelWhenOutside(false)
				.onBegin(() => {
					"worklet";
					grabbed.value = progress.value;
					isPressed.value = withSpring(1, SWITCH_PRESS_SPRING);
					scheduleOnRN(setDragging, true);
				})
				.onUpdate((event) => {
					"worklet";
					const travel = switchTravel({
						inset: SWITCH_THUMB_INSET,
						thumbWidth: thumbWidth.value,
						trackWidth: trackWidth.value,
					});
					if (travel <= 0) return;

					progress.value = Math.min(1, Math.max(0, grabbed.value + event.translationX / travel));
				})
				.onFinalize((event) => {
					"worklet";
					// Whichever axis moved further. A vertical swipe that began on the
					// switch has to count as movement, or every attempt to scroll past
					// the control would read as a tap and toggle it.
					const target = resolveSwitchRelease({
						distance: Math.max(Math.abs(event.translationX), Math.abs(event.translationY)),
						progress: progress.value,
						velocity: event.velocityX,
						wasSelected: selected,
					});

					progress.value = withSpring(target ? 1 : 0, SWITCH_THUMB_SPRING);
					isPressed.value = withSpring(0, SWITCH_PRESS_SPRING);
					// At the commit, never at the grab. A drag taken half way and
					// released back has changed nothing, and a switch that buzzed for it
					// would be reporting a state change that did not happen.
					if (haptic !== false && target !== selected) playHaptic(haptic);

					// Order matters: the root must have stopped treating this as a live
					// drag before `commit` asks it to re-sync. `scheduleOnRN` keeps them
					// in the order they were queued.
					scheduleOnRN(setDragging, false);
					scheduleOnRN(commit, target);
				}),
		[axes.isDisabled, commit, grabbed, haptic, isPressed, progress, selected, setDragging, thumbWidth, trackWidth]
	);

	const toggle = useCallback(() => {
		commit(!selectedRef.current);
	}, [commit]);

	// Offered to an enclosing `Field` so tapping the label or the description
	// beside the switch flips it. A switch in a form is a small pill next to a
	// sentence, and the sentence is what people aim at.
	//
	// Registered through a ref-backed trampoline rather than `toggle` itself, the
	// way `Checkbox` does it: re-registering whenever the state changed would
	// re-render the whole field for nothing.
	const toggleRef = useRef(toggle);
	toggleRef.current = toggle;
	const registerPress = field?.registerPress;
	const stableToggle = useCallback(() => toggleRef.current(), []);

	useEffect(() => {
		if (!registerPress) return;
		registerPress(stableToggle);
		return () => registerPress(null);
	}, [registerPress, stableToggle]);

	const trackTokens = resolveSwitchTrackTokens({ color: axes.color, isInvalid: axes.isInvalid });
	const restColor = useThemeColor(trackTokens.rest) ?? "transparent";
	const activeColor = useThemeColor(trackTokens.active) ?? "transparent";

	// One animated style on one node: the colour the switch travels through and
	// the press scale are two entries here rather than two `useAnimatedStyle`
	// calls, because two on one view fight for the same props and the later one
	// silently wins — the rule `Radio.Indicator` states.
	//
	// The colour interpolates off `progress` rather than running a timing of its
	// own against `selected`, so the track colours *with the finger* through a
	// drag instead of snapping when it is let go. A separate timing would also be
	// a second clock the position could drift from.
	const trackStyle = useAnimatedStyle(() => ({
		backgroundColor: interpolateColor(progress.value, [0, 1], [restColor, activeColor]),
		transform: [
			{
				scale:
					SWITCH_PRESS_ANIMATION.restScale -
					isPressed.value * (SWITCH_PRESS_ANIMATION.restScale - SWITCH_PRESS_ANIMATION.pressedScale),
			},
		],
	}));

	const context = useMemo<SwitchContextValue>(
		() => ({
			color: axes.color,
			isDisabled: axes.isDisabled,
			isInvalid: axes.isInvalid,
			isSelected: selected,
			progress,
			size: axes.size,
			thumbWidth,
			trackWidth,
		}),
		[axes.color, axes.isDisabled, axes.isInvalid, axes.size, progress, selected, thumbWidth, trackWidth]
	);

	const content = useMemo(() => withThumb(children), [children]);
	const slots = switchVariants({ isDisabled: axes.isDisabled, size: axes.size });

	const handleAccessibilityAction = useCallback(
		(event: AccessibilityActionEvent) => {
			if (event.nativeEvent.actionName === "activate") toggle();
		},
		[toggle]
	);

	return (
		<SwitchProvider value={context}>
			<GestureDetector gesture={gesture}>
				<Animated.View
					accessibilityActions={ACCESSIBILITY_ACTIONS}
					accessibilityRole="switch"
					accessibilityState={{ checked: selected, disabled: axes.isDisabled }}
					// Without this the view is not an accessibility element on iOS, and
					// the role and the state above never reach VoiceOver. It also merges
					// the parts into one element, which is what a control should be.
					accessible
					className={slots.touchArea({ className })}
					onAccessibilityAction={handleAccessibilityAction}
					onAccessibilityTap={toggle}
					{...props}
				>
					<Animated.View className={slots.track()} onLayout={handleLayout} style={trackStyle}>
						{content}
					</Animated.View>
				</Animated.View>
			</GestureDetector>
		</SwitchProvider>
	);
}

/**
 * The one action an assistive double-tap on a `switch` maps to.
 *
 * Module scope on purpose: a fresh array each render is a new prop every commit,
 * and React Native sends the whole accessibility config across on any change.
 *
 * It exists at all because the root is not a `Pressable` — there is no touch
 * responder for TalkBack's activation to land on, so without this the switch
 * would announce its state and offer no way to change it. `onAccessibilityTap`
 * is the iOS half of the same gap.
 */
const ACCESSIBILITY_ACTIONS = [{ name: "activate" }] as const;

/**
 * Composes a `Switch.Thumb` in, and puts it last however it was written.
 *
 * Composed in when the children hold none, so `<Switch />` on its own is already
 * a complete control — `Radio`'s rule for its indicator, and the same reasoning:
 * a switch has exactly one thumb, so a caller who wrote none wants the default
 * rather than an empty capsule.
 *
 * **Moved to the end when they did write one.** Every part here is absolutely
 * positioned, and React Native paints later siblings on top — so a thumb written
 * first, which is the order the anatomy reads best in, would slide *under* the
 * content layers. Reordering here rather than asking the caller to is the
 * difference between an anatomy that documents itself and one that has a gotcha.
 *
 * {@link hasThumbChild} is the decision and is pure, so `bun test` reaches it.
 *
 * Lives here rather than with the parts: it is the root that arranges its own
 * children, and importing it from a part would close a cycle. See AGENTS.md.
 */
function withThumb(children: ReactNode): ReactNode {
	const items = Children.toArray(children);
	const isThumb = items.map(isSwitchThumbElement);

	if (!hasThumbChild(isThumb)) return [...items, <SwitchThumb key="thumb" />];

	return [...items.filter((_, index) => !isThumb[index]), ...items.filter((_, index) => isThumb[index])];
}

/**
 * Whether a child is a `Switch.Thumb`.
 *
 * **Reference equality is asked first and is not trusted alone.** A consuming
 * app compiles this package's source itself — the package ships raw `.tsx` — so
 * the function this module holds and the one behind a caller's `<Switch.Thumb>`
 * are only the same object while nothing has rewritten the binding in between.
 * React Compiler does exactly that, and Metro can serve two instances of one
 * module through a workspace symlink; either leaves an element whose `type` is a
 * different object standing for the same component.
 *
 * The failure is silent and specific: detection returns false, a second thumb is
 * composed in on top of the caller's, and because the two are the same size and
 * colour the only visible symptom is that anything *inside* the caller's knob
 * disappears under the default one. It cost an afternoon to find, which is why
 * the check no longer rests on identity.
 *
 * `displayName` is what it rests on instead. Rule 12 requires every component in
 * this package to carry one, `display-name.test.ts` enforces that they are
 * present and unique, and it survives every rewrite above because it is a
 * property assigned to the function rather than the function itself. Read off
 * the element's own `type`, which is a function today and would be an object if
 * this part were ever wrapped in `memo`.
 */
function isSwitchThumbElement(child: ReactNode): boolean {
	if (!isValidElement(child)) return false;
	if (child.type === SwitchThumb) return true;

	const type = child.type as { displayName?: string } | null;
	return type?.displayName !== undefined && type.displayName === SwitchThumb.displayName;
}

/**
 * A binary preference, flipped by a tap or by dragging its thumb.
 *
 * The whole pill is the control and one `Gesture.Pan()` drives it: a tap toggles,
 * a drag takes the thumb with the finger, and a release settles by position or by
 * a flick's velocity. There is no separate tap mode — a release that barely moved
 * *is* the tap, which is why the two never race.
 *
 * A `Switch.Thumb` is composed in when the children hold none, so `<Switch />` is
 * already complete. Anything else composed inside lands *behind* the thumb at one
 * end of the track: `Switch.StartContent` is revealed as the switch turns on and
 * `Switch.EndContent` as it turns off, each fading with the thumb's own travel, so
 * both are written once with no conditionals. The thumb is drawn last however the
 * children were ordered.
 *
 * **State works either way from one hook**: pass `isSelected` to control it, or
 * nothing and let it hold its own.
 *
 * `isInvalid` and `isDisabled` cascade in from an enclosing `Field`, so
 * `<Field isDisabled>` dims it with nothing said here — and an explicit prop still
 * wins, in either direction. Inside a `Field` the switch also hands its toggle
 * back up, so tapping a `Field.Label` or the description under it flips it.
 *
 * There is no `Switch.Label`: the track is a fixed pill and a label cannot sit
 * inside it, so the name is a `Field.Label` or a `ListGroup.ItemTitle` a row away.
 * A switch with no label anywhere near it needs an `accessibilityLabel`, the same
 * rule an icon-sized `Button` follows.
 *
 * A haptic fires when a gesture actually flips it — never on the grab, since a
 * drag taken half way and released back has changed nothing. `haptic={false}`
 * silences it.
 *
 * @example
 * <Switch isSelected={isOn} onSelectedChange={setOn} />
 *
 * @example
 * <Field orientation="horizontal">
 *   <Field.Content>
 *     <Field.Label>Notifications</Field.Label>
 *     <Field.Description>Push alerts for new messages.</Field.Description>
 *   </Field.Content>
 *   <Switch color="success" isSelected={alerts} onSelectedChange={setAlerts} />
 * </Field>
 *
 * @example
 * <Switch defaultSelected size="lg">
 *   <Switch.StartContent>
 *     <Icon icon={IconCheckmark1Small} />
 *   </Switch.StartContent>
 *   <Switch.EndContent>
 *     <Icon icon={IconXmarkSmall} />
 *   </Switch.EndContent>
 * </Switch>
 */
export const Switch = Object.assign(SwitchRoot, {
	/** The knob. Composed in automatically; write it out to restyle it or fill it. */
	Thumb: SwitchThumb,
	/** Behind the thumb at the leading edge — revealed as the switch turns on. */
	StartContent: SwitchStartContent,
	/** Behind the thumb at the trailing edge — revealed as the switch turns off. */
	EndContent: SwitchEndContent,
	displayName: "DelacourUI.Switch",
});
