import { Children, isValidElement, type ReactElement, type ReactNode, useCallback, useMemo, useRef } from "react";
import { View, type ViewProps } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { cn } from "@/lib/cn";
import { TabsListProvider, type TabsListValue, useTabsPart } from "./tabs.context";
import {
	isTriggerOrderConsistent,
	resolveMeasurementTracks,
	type TabMeasurement,
	type TabTracks,
	tabsVariants,
} from "./tabs.variants";
import { TabsScrollView } from "./tabs-scroll-view";

export type TabsListProps = ViewProps & {
	className?: string;
	children?: ReactNode;
};

/**
 * The bar itself: the track, and the frame every trigger measures itself into.
 *
 * It owns the measurement registry, which is why `Tabs.Indicator` and
 * `Tabs.Trigger` throw by name outside one — an indicator with nothing to measure
 * has no other way of saying so.
 *
 * **The registry is a JS-side map published as one shared value, coalesced to one
 * write per tick.** Every `onLayout` in a layout pass lands in the same tick, so
 * without the coalescing an eight-tab bar writes the shared value eight times and
 * the UI thread can render between two of them — showing an indicator built from
 * four new positions and four old ones. A microtask still runs before paint, so
 * the coalescing costs nothing.
 *
 * **The track and the row are always two elements, never one.** It is tempting to
 * put the track's padding and the row's layout on a single View when nothing
 * scrolls — and it is wrong, silently. `Tabs.Indicator` is absolutely positioned,
 * and an absolute child resolves its insets against its parent's *padding box*:
 * `inset-y-0` would span the track's full height while the triggers sat inside
 * the padding, so the capsule and the track would come out exactly the same
 * height. Two pills of equal radius offset horizontally do not nest — their
 * curves cross, and the ends show a sliver of track between them. Measured on a
 * simulator at 3×: 12px of gap at the sides and 0px top and bottom.
 *
 * With the row as its own element the indicator's containing block is the row, so
 * `inset-y-0` is exactly the trigger's height and the capsule is concentric on
 * every axis. A `Tabs.ScrollView` already had this shape — its content container
 * is the row — which is why the bug only ever showed on a bar that did not
 * scroll. The two paths are now identical.
 */
export function TabsList({ className, children, ...props }: TabsListProps): ReactElement {
	const { order, size, variant } = useTabsPart("Tabs.List");

	// The JS-side source of truth. A ref rather than state: a layout re-renders
	// nothing here, and the same map is what the indicator and the bar's own
	// auto-scroll both read — one measurement, two consumers, so they can never
	// disagree about where a tab is.
	const measured = useRef<Record<string, TabMeasurement>>({});
	const tracks = useSharedValue<TabTracks | null>(null);
	const isPublishQueued = useRef(false);

	// Read inside the microtask rather than captured when it was queued: a tab
	// removed in between would otherwise publish a track for a value that no
	// longer exists.
	const orderRef = useRef(order);
	orderRef.current = order;

	const scrollX = useSharedValue(0);
	const viewportWidth = useSharedValue(0);
	const contentWidth = useSharedValue(0);
	const isBarDragging = useSharedValue(false);

	const publish = useCallback(() => {
		if (isPublishQueued.current) return;
		isPublishQueued.current = true;
		queueMicrotask(() => {
			isPublishQueued.current = false;
			const next = resolveMeasurementTracks(orderRef.current, measured.current);
			tracks.value = next;

			if (process.env.NODE_ENV !== "production" && next && !isTriggerOrderConsistent(next.x)) {
				console.warn(
					"Tabs: the triggers do not run left to right in the order their panels are written, so the indicator will land on the wrong tab. Write <Tabs.Trigger> in the same order as <Tabs.Content>, and do not wrap a trigger in a view of its own — a wrapped trigger measures itself against the wrapper rather than the row."
				);
			}
		});
	}, [tracks]);

	const measure = useCallback(
		(value: string, measurement: TabMeasurement) => {
			const previous = measured.current[value];
			// A re-layout reporting identical numbers is not a change, and writing the
			// shared value anyway would invalidate every worklet reading it.
			if (previous && previous.x === measurement.x && previous.width === measurement.width) return;
			measured.current[value] = measurement;
			publish();
		},
		[publish]
	);

	const unmeasure = useCallback(
		(value: string) => {
			if (!(value in measured.current)) return;
			delete measured.current[value];
			publish();
		},
		[publish]
	);

	const context = useMemo<TabsListValue>(
		() => ({ contentWidth, isBarDragging, measure, scrollX, tracks, unmeasure, viewportWidth }),
		[contentWidth, isBarDragging, measure, scrollX, tracks, unmeasure, viewportWidth]
	);

	const isScrollable = useMemo(() => holdsScrollView(children), [children]);
	const slots = tabsVariants({ isScrollable, size, variant });

	return (
		<TabsListProvider value={context}>
			<View accessibilityRole="tablist" className={cn(slots.list(), className)} {...props}>
				{isScrollable ? children : <View className={slots.row()}>{children}</View>}
			</View>
		</TabsListProvider>
	);
}
TabsList.displayName = "DelacourUI.Tabs.List";

/**
 * Whether the row is rendered by a `Tabs.ScrollView` inside this list.
 *
 * The scroller lays the triggers out in its own content container, so a list that
 * also wore the row's layout would put a second flex row around it — a gap and a
 * stretch that belong to a row of triggers, applied to a single scroll view.
 */
function holdsScrollView(children: ReactNode): boolean {
	for (const child of Children.toArray(children)) {
		if (isValidElement(child) && child.type === TabsScrollView) return true;
	}
	return false;
}
