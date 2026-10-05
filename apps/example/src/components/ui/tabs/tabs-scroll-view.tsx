import { type ComponentRef, type ReactElement, type ReactNode, type Ref, useCallback, useEffect } from "react";
import type { LayoutChangeEvent, ScrollViewProps } from "react-native";
import Animated, {
	Extrapolation,
	interpolate,
	scrollTo,
	useAnimatedReaction,
	useAnimatedRef,
	useAnimatedScrollHandler,
} from "react-native-reanimated";
import { TabsScrollableProvider, useTabsListPart, useTabsMotionPart, useTabsPart } from "./tabs.context";
import { resolveScrollOffset, TABS_DEFAULT_SCROLL_ALIGN, type TabsScrollAlign, tabsVariants } from "./tabs.variants";

export type TabsScrollViewProps = Omit<ScrollViewProps, "children" | "horizontal"> & {
	/**
	 * Where the selected trigger is scrolled to when the selection changes.
	 *
	 * `none` leaves the bar exactly where it is — for a row the caller drives
	 * itself. Every alignment is clamped at both ends, so the first and last tabs
	 * never scroll the row past its own content.
	 */
	scrollAlign?: TabsScrollAlign;
	className?: string;
	/** Merged after the row's own layout, never instead of it. */
	contentContainerClassName?: string;
	children?: ReactNode;
	ref?: Ref<ComponentRef<typeof Animated.ScrollView>>;
};

/**
 * The horizontal scroller a bar with more tabs than room puts its row in.
 *
 * `horizontal` is `Omit`ed rather than defaulted. Every measurement in this
 * component is an `x` and a width, so `horizontal={false}` would leave all of that
 * arithmetic intact and silently wrong — a bar that scrolled the wrong way with an
 * indicator that did not move.
 *
 * **It scrolls from the UI thread**, through the package's only `useAnimatedRef`.
 * The reaction interpolates the *fractional* trigger geometry off the same
 * `position` the indicator reads, so the row tracks a finger through a drag rather
 * than jumping once the swipe has settled. Mirroring the offset back to JS and
 * calling `scrollTo` there would be a round trip per frame, which is the one thing
 * this whole component is arranged to avoid.
 *
 * **A hand-scroll always wins, and the flag it sets clears on momentum end rather
 * than on the finger lifting.** A flick leaves the bar coasting after the touch is
 * gone, and retargeting into that coast is a tug-of-war the user feels as the row
 * snapping backwards mid-flight.
 *
 * The caller's `ref` is composed rather than taken: this needs an animated handle
 * of its own, and someone who wants the same handle should not have to give one up.
 */
export function TabsScrollView({
	scrollAlign = TABS_DEFAULT_SCROLL_ALIGN,
	className,
	contentContainerClassName,
	children,
	ref,
	onLayout,
	onContentSizeChange,
	...props
}: TabsScrollViewProps): ReactElement {
	const { size, variant } = useTabsPart("Tabs.ScrollView");
	const { position } = useTabsMotionPart("Tabs.ScrollView");
	const { tracks, scrollX, viewportWidth, contentWidth, isBarDragging } = useTabsListPart("Tabs.ScrollView");

	const scrollRef = useAnimatedRef<ComponentRef<typeof Animated.ScrollView>>();

	// The animated ref is the one this ScrollView has to carry — `scrollTo`
	// resolves a view tag through it and a composed callback is not that — so a
	// caller's ref is forwarded after mount rather than merged into the prop.
	useEffect(() => {
		if (!ref) return;
		const node = scrollRef.current;
		if (typeof ref === "function") {
			ref(node);
			return () => {
				ref(null);
			};
		}
		ref.current = node;
		return () => {
			ref.current = null;
		};
	}, [ref, scrollRef]);

	const scrollHandler = useAnimatedScrollHandler({
		onScroll: (event) => {
			scrollX.value = event.contentOffset.x;
			viewportWidth.value = event.layoutMeasurement.width;
			contentWidth.value = event.contentSize.width;
		},
		onBeginDrag: () => {
			isBarDragging.value = true;
		},
		onEndDrag: (event) => {
			// Only when the finger left nothing behind it. Anything else is handed to
			// `onMomentumEnd`, which is the callback that knows the bar has stopped.
			if (!event.velocity || event.velocity.x === 0) isBarDragging.value = false;
		},
		onMomentumEnd: () => {
			isBarDragging.value = false;
		},
	});

	// Seeded here as well as from `onScroll`, because a bar whose row fits never
	// fires a scroll event at all — and would then auto-scroll against a content
	// width of zero.
	const handleLayout = useCallback(
		(event: LayoutChangeEvent) => {
			onLayout?.(event);
			viewportWidth.value = event.nativeEvent.layout.width;
		},
		[onLayout, viewportWidth]
	);

	const handleContentSizeChange = useCallback(
		(width: number, height: number) => {
			onContentSizeChange?.(width, height);
			contentWidth.value = width;
		},
		[contentWidth, onContentSizeChange]
	);

	useAnimatedReaction(
		() => position.value,
		(current) => {
			if (scrollAlign === "none" || isBarDragging.value) return;
			const measured = tracks.value;
			if (!measured) return;

			scrollTo(
				scrollRef,
				resolveScrollOffset({
					align: scrollAlign,
					contentWidth: contentWidth.value,
					currentOffset: scrollX.value,
					viewportWidth: viewportWidth.value,
					width: interpolate(current, measured.index, measured.width, Extrapolation.CLAMP),
					x: interpolate(current, measured.index, measured.x, Extrapolation.CLAMP),
				}),
				0,
				// The spring is already animating `position`; a second animated scroll
				// on top of it would be two easing curves fighting for the same pixels.
				false
			);
		},
		[scrollAlign]
	);

	const slots = tabsVariants({ isScrollable: true, size, variant });

	return (
		<TabsScrollableProvider value={true}>
			<Animated.ScrollView
				className={slots.scroll({ className })}
				contentContainerClassName={slots.row({ className: contentContainerClassName })}
				horizontal
				onContentSizeChange={handleContentSizeChange}
				onLayout={handleLayout}
				onScroll={scrollHandler}
				ref={scrollRef}
				showsHorizontalScrollIndicator={false}
				{...props}
			>
				{children}
			</Animated.ScrollView>
		</TabsScrollableProvider>
	);
}
TabsScrollView.displayName = "DelacourUI.Tabs.ScrollView";
