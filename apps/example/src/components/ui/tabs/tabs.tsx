import {
	Children,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { View, type ViewProps } from "react-native";
import { Gesture } from "react-native-gesture-handler";
import { cancelAnimation, useAnimatedReaction, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useControllableState } from "@/hooks/use-controllable-state";
import { type TabsContextValue, TabsMotionProvider, type TabsMotionValue, TabsProvider } from "./tabs.context";
import {
	resolveInitialValue,
	resolvePanOrigin,
	resolvePanPosition,
	resolveReconcileMode,
	resolveSettleIndex,
	resolveTabIndex,
	resolveTabOrder,
	resolveVisualIndex,
	shouldEmitTabChange,
	TABS_DEFAULT_SIZE,
	TABS_DEFAULT_VARIANT,
	TABS_PAN,
	TABS_SETTLE_SPRING,
	type TabsSize,
	type TabsVariant,
	tabsVariants,
} from "./tabs.variants";
import { TabsContent } from "./tabs-content";
import { TabsIndicator } from "./tabs-indicator";
import { TabsLabel } from "./tabs-label";
import { TabsList } from "./tabs-list";
import { TabsPager } from "./tabs-pager";
import { TabsScrollView } from "./tabs-scroll-view";
import { TabsSeparator } from "./tabs-separator";
import { TabsTrigger } from "./tabs-trigger";

export type TabsProps = Omit<ViewProps, "children"> & {
	/**
	 * The selected tab's value.
	 *
	 * `null` means "controlled, nothing selected". Omitting the prop entirely is
	 * what makes the bar uncontrolled, so a `useState<string>()` seeded with
	 * `undefined` would silently hand the component its own state and then switch
	 * it to controlled on the first press. Pass `tab ?? null`.
	 */
	value?: string | null;
	/** The tab selected to begin with, while uncontrolled. Defaults to the first. */
	defaultValue?: string | null;
	/** Called with the newly selected value. Never called for a re-press of the current one. */
	onValueChange?: (value: string) => void;
	/** How the bar is painted: a segmented track, an underline, or a floating capsule. */
	variant?: TabsVariant;
	/** Drives the trigger's floor and padding, the gap ladder and the label's step, on one axis. */
	size?: TabsSize;
	/**
	 * A horizontal pan on the panels drags them and drives the indicator with it.
	 *
	 * On by default, and it is exactly one thing: whether the gesture is enabled.
	 * It does not change what mounts — every panel is mounted either way, because
	 * you cannot drag to one that is not there and because a panel that unmounted
	 * would lose what was typed into it. See `Tabs.Content` for the per-panel
	 * escape hatch.
	 */
	isSwipeable?: boolean;
	/** Disables every trigger. A trigger that names the axis still wins, either way. */
	isDisabled?: boolean;
	className?: string;
	children?: ReactNode;
};

function TabsRoot({
	value: valueProp,
	defaultValue,
	onValueChange,
	variant = TABS_DEFAULT_VARIANT,
	size = TABS_DEFAULT_SIZE,
	isSwipeable = true,
	isDisabled,
	className,
	children,
	...props
}: TabsProps): ReactElement {
	const { content, values } = useMemo(() => withPager(children), [children]);

	// Only consulted for a bar with no panels at all — a filter row driving a list
	// somewhere else. With panels present the registration is a no-op, so a bar
	// that has them does not re-render once per trigger on mount.
	const hasPanels = values.length > 0;
	const [registered, setRegistered] = useState<readonly string[]>([]);
	const registerValue = useCallback(
		(value: string) => {
			if (hasPanels) return noop;
			setRegistered((current) => (current.includes(value) ? current : [...current, value]));
			return () => setRegistered((current) => current.filter((name) => name !== value));
		},
		[hasPanels]
	);

	const order = useMemo(() => resolveTabOrder(values, registered), [values, registered]);
	const count = order.length;

	const [selected, setSelected] = useControllableState<string | null>({
		value: valueProp,
		defaultValue: resolveInitialValue(order, defaultValue),
		onChange: handleValueChange(onValueChange),
	});

	const selectedIndex = resolveTabIndex(order, selected);

	const position = useSharedValue(selectedIndex < 0 ? 0 : selectedIndex);
	const pageWidth = useSharedValue(0);
	const panStart = useSharedValue(0);
	// Whether the pan actually became active. `onFinalize` fires for every touch
	// the pager sees, including ones that never activated, and it must not settle
	// those — see the gesture below.
	const isPanning = useSharedValue(false);

	// Where `position` is settled or heading. A plain ref rather than a shared
	// value: only the JS thread ever asks, and a `.value` read from an effect
	// closure is the strict-mode hazard `use-screen-scroll-insets` documents.
	const target = useRef({ index: selectedIndex < 0 ? 0 : selectedIndex, value: selected });

	// Bumped alongside every commit, and being unread in the body is the point. A
	// CONTROLLED parent that rejects a change re-renders nothing, so a reconcile
	// waiting on the parent's commit would never run and the pager would sit on a
	// panel the caller's state says is not selected. `Switch` carries the same
	// token for the same reason.
	const [commits, requestReconcile] = useReducer((n: number) => n + 1, 0);

	const selectedRef = useRef(selected);
	selectedRef.current = selected;

	const select = useCallback(
		(next: string) => {
			if (!shouldEmitTabChange(selectedRef.current, next)) return;
			setSelected(next);
			requestReconcile();
		},
		[setSelected]
	);

	// Called from the pan alone. The gesture has ALREADY started the settle spring,
	// so this records where it aimed — which is what makes the reconcile below a
	// no-op when the change is accepted, leaving the fling its momentum, and a
	// spring back when it is not.
	const orderRef = useRef(order);
	orderRef.current = order;
	const commitFromPan = useCallback(
		(nextIndex: number) => {
			const nextValue = orderRef.current[nextIndex];
			if (nextValue === undefined) return;
			target.current = { index: nextIndex, value: nextValue };
			setSelected(nextValue);
			requestReconcile();
		},
		[setSelected]
	);

	// Deliberately without a dependency array: it runs after every commit and
	// repairs any divergence between where `position` is heading and what React
	// says is selected. Two ref reads and a comparison — the guard is what keeps it
	// from being three springs a second.
	//
	// **It registers no cleanup, and that is the whole of a bug this component
	// shipped once.** `Checkbox` and `Switch` end their effects with
	// `cancelAnimation`, and both can: their effect starts a fresh animation on
	// every run, so a cleanup that cancels the previous one always has a
	// replacement behind it. This effect does not — its `none` branch returns
	// early — and the commit that runs the cleanup is the one the *gesture* just
	// caused. So a swipe would start its settle spring, `commitFromPan` would
	// re-render, the previous run's cleanup would cancel that spring, and the new
	// run would take the `none` branch and restart nothing. The pager froze part
	// way between two panels, intermittently, depending on whether the commit beat
	// the spring. An in-flight spring on an unmounted bar is harmless — the shared
	// value goes with the component — so there is nothing here to clean up.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `commits` is the re-run token, see above
	useEffect(() => {
		const mode = resolveReconcileMode({
			selectedIndex,
			selectedValue: selected,
			targetIndex: target.current.index,
			targetValue: target.current.value,
		});
		if (mode === "none") return;

		target.current = { index: selectedIndex, value: selected };
		position.value = mode === "jump" ? selectedIndex : withSpring(selectedIndex, TABS_SETTLE_SPRING);
	}, [commits, position, selected, selectedIndex]);

	const panGesture = useMemo(
		() =>
			Gesture.Pan()
				// One builder call is the whole of `isSwipeable`. Nothing else in the
				// component branches on it.
				.enabled(isSwipeable && count > 1)
				// The pager claims a sideways drag and gives up a vertical one, which is
				// what lets it live inside a scrolling screen at all. `blocksExternalGesture`
				// is not the alternative: `Screen.ScrollArea` renders React Native's own
				// `ScrollView`, which has no handler tag to resolve, so the call is
				// dropped without an error — see `Slider.Track`.
				.activeOffsetX([-TABS_PAN.activateX, TABS_PAN.activateX])
				.failOffsetY([-TABS_PAN.failY, TABS_PAN.failY])
				// The spring is cancelled on ACTIVATION, never on touch-down. `onBegin`
				// fires for every touch the pager sees — a tap on a panel, the start of
				// a vertical scroll — and most of those go on to FAIL against
				// `failOffsetY`. Cancelling there would kill an in-flight settle for a
				// gesture that never became a drag, and since `onEnd` only runs for a
				// pan that actually activated, nothing would ever restart it: the pager
				// freezes half way between two panels. Found by dragging, then scrolling
				// the page before the spring had finished.
				.onStart((event) => {
					"worklet";
					cancelAnimation(position);
					isPanning.value = true;
					// Interruptible: grabbing a pager mid-settle picks it up where it is
					// rather than snapping to the target first.
					panStart.value = resolvePanOrigin(position.value, event.translationX, pageWidth.value);
				})
				.onUpdate((event) => {
					"worklet";
					position.value = resolvePanPosition({
						count,
						pageWidth: pageWidth.value,
						startPosition: panStart.value,
						translationX: event.translationX,
					});
				})
				// `onFinalize`, not `onEnd`, because it is the one callback that runs on
				// every path out of the gesture — END, FAILED and CANCELLED alike, from
				// any state. `Slider.Track` states the same rule for the same reason. A
				// drag cancelled mid-flight by the OS or by another handler reaches only
				// this one, and without it the pager would be left wherever the finger
				// happened to be. The flag is what keeps a touch that never activated
				// from retargeting a spring it never disturbed.
				.onFinalize((event, success) => {
					"worklet";
					if (!isPanning.value) return;
					isPanning.value = false;

					const width = pageWidth.value;
					// Index units per second, so the threshold means the same flick on a
					// phone as on a tablet.
					const velocity = success && width > 0 ? -event.velocityX / width : 0;
					const startIndex = Math.round(panStart.value);
					const next = resolveSettleIndex({ count, position: position.value, startIndex, velocity });

					position.value = withSpring(next, { ...TABS_SETTLE_SPRING, velocity });

					if (next !== startIndex) scheduleOnRN(commitFromPan, next);
				}),
		[commitFromPan, count, isPanning, isSwipeable, pageWidth, panStart, position]
	);

	// The visual selection, and the one hop from the UI thread back to React that
	// is not the value itself. Without it a filled capsule sitting halfway over the
	// next tab carries that tab's unselected label colour, which is unreadable for
	// the whole of a drag. The hysteresis band is what stops a finger held at the
	// midpoint from flipping it every frame.
	const [visualIndex, setVisualIndex] = useState(selectedIndex < 0 ? 0 : selectedIndex);
	const visual = useSharedValue(selectedIndex < 0 ? 0 : selectedIndex);

	useAnimatedReaction(
		() => resolveVisualIndex(position.value, visual.value, count),
		(current, previous) => {
			if (current === previous) return;
			visual.value = current;
			scheduleOnRN(setVisualIndex, current);
		},
		[count]
	);

	const context = useMemo<TabsContextValue>(
		() => ({ isDisabled, isSwipeable, order, registerValue, select, size, value: selected, variant, visualIndex }),
		[isDisabled, isSwipeable, order, registerValue, select, size, selected, variant, visualIndex]
	);

	const motion = useMemo<TabsMotionValue>(
		() => ({ pageWidth, panGesture, position }),
		[pageWidth, panGesture, position]
	);

	return (
		<TabsProvider value={context}>
			<TabsMotionProvider value={motion}>
				<View className={tabsVariants({ size, variant }).root({ className })} {...props}>
					{content}
				</View>
			</TabsMotionProvider>
		</TabsProvider>
	);
}

/** A stable no-op, so a registration that does nothing does not mint a function per render. */
function noop(): void {
	return;
}

/**
 * Adapts `useControllableState`'s nullable setter to `onValueChange`.
 *
 * Declared outside the render so the identity is stable per `onValueChange`, or
 * the setter rebuilds every render, which rebuilds the context, which re-renders
 * every trigger in the bar — `Radio.Group`'s note.
 */
function handleValueChange(onValueChange?: (value: string) => void): (next: string | null) => void {
	return (next) => {
		if (next !== null) onValueChange?.(next);
	};
}

/**
 * Collects every `Tabs.Content` child into one pager, in place of the first.
 *
 * The panels are the ORDER OF RECORD: their source order is what the pager
 * translates through, what the indicator interpolates over and what the pan snaps
 * to. Triggers are not walked at all — a trigger finds its own index by looking
 * its `value` up in this list, so it may sit behind any wrapper, come out of a
 * `.map()`, or be written in a different order without anything moving.
 *
 * That is why the panels are the ones required to be direct children rather than
 * the triggers. Walking triggers would break the moment anyone wrote
 * `<FilterTabs />` or wrapped a pair in a `View`: the walk would see a component
 * it does not recognise and silently drop tabs from the list. A panel is the one
 * part nobody has a reason to wrap.
 *
 * The pager takes the place of the FIRST panel rather than being appended, so a
 * `Tabs.List` above and anything below keep the positions the caller wrote them
 * in. `Children.toArray` drops the nulls a conditional panel leaves behind, the
 * same reason `withDividers` calls it.
 *
 * Lives here rather than with the parts: it is the root that rearranges its own
 * children, and importing it from a part would close a cycle. See AGENTS.md.
 */
function withPager(children: ReactNode): { content: ReactNode; values: string[] } {
	const items = Children.toArray(children);
	const panels: ReactNode[] = [];
	const values: string[] = [];

	for (const child of items) {
		if (!isValidElement(child) || child.type !== TabsContent) continue;
		panels.push(child);
		values.push((child.props as { value: string }).value);
	}

	if (panels.length === 0) return { content: items, values };

	const output: ReactNode[] = [];
	let placed = false;

	for (const child of items) {
		if (isValidElement(child) && child.type === TabsContent) {
			if (placed) continue;
			output.push(<TabsPager key="pager">{panels}</TabsPager>);
			placed = true;
			continue;
		}
		output.push(child);
	}

	return { content: output, values };
}

/**
 * A row of tabs, and the panels they switch between.
 *
 * The whole component moves off one shared value: a float index into the panels'
 * own order. A press springs it, a drag writes it directly, and the indicator, the
 * panels and every separator read it — so the capsule follows a finger through a
 * swipe rather than snapping when it is let go, and nothing can drift a frame out
 * of step with anything else.
 *
 * **The panels are the order of record and must be direct children**, the same ask
 * `ListGroup` makes of its rows. Triggers may be written any way at all; each one
 * finds its place by its `value`.
 *
 * **State works either way from one hook**: pass `value` to control it, or nothing
 * and let the bar hold its own, starting on the first tab.
 *
 * A trigger with no text needs an `accessibilityLabel`, the same rule an icon-sized
 * `Button` follows.
 *
 * @example
 * <Tabs onValueChange={setTab} value={tab}>
 *   <Tabs.List>
 *     <Tabs.Indicator />
 *     <Tabs.Trigger value="overview">Overview</Tabs.Trigger>
 *     <Tabs.Trigger value="activity">Activity</Tabs.Trigger>
 *   </Tabs.List>
 *   <Tabs.Content value="overview"><Overview /></Tabs.Content>
 *   <Tabs.Content value="activity"><Activity /></Tabs.Content>
 * </Tabs>
 *
 * @example
 * <Tabs variant="secondary">
 *   <Tabs.List>
 *     <Tabs.ScrollView scrollAlign="center">
 *       <Tabs.Indicator />
 *       {sections.map((section) => (
 *         <Tabs.Trigger key={section.id} value={section.id}>
 *           <Tabs.Label>{section.title}</Tabs.Label>
 *         </Tabs.Trigger>
 *       ))}
 *     </Tabs.ScrollView>
 *   </Tabs.List>
 *   {sections.map((section) => (
 *     <Tabs.Content key={section.id} value={section.id}>{section.body}</Tabs.Content>
 *   ))}
 * </Tabs>
 */
export const Tabs = Object.assign(TabsRoot, {
	/** The bar: the track, and the frame every trigger measures itself into. */
	List: TabsList,
	/** A horizontal scroller for a bar with more tabs than room. */
	ScrollView: TabsScrollView,
	/** The one layer that slides. Write it out as the row's first child. */
	Indicator: TabsIndicator,
	/** One tab. A `Pressable`, so it inherits the whole vocabulary. */
	Trigger: TabsTrigger,
	/** A trigger's text. Bare string children become one automatically. */
	Label: TabsLabel,
	/** A hairline between two tabs, which retreats as either is approached. */
	Separator: TabsSeparator,
	/** One panel. Must be a direct child of `Tabs` — its place in the source is its place in the order. */
	Content: TabsContent,
	displayName: "DelacourUI.Tabs",
});
