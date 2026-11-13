import { createContext, type ReactElement, type ReactNode, use, useCallback, useMemo } from "react";
import type { LayoutChangeEvent, ScrollViewInstance } from "react-native";
import {
	type AnimatedRef,
	type SharedValue,
	useAnimatedRef,
	useAnimatedScrollHandler,
	useSharedValue,
} from "react-native-reanimated";
import { readScrollEvent, type ScrollEventFields, type ScrollOrientation } from "@/lib/scroll-maths";

export type { ScrollEventFields, ScrollOrientation } from "@/lib/scroll-maths";

/** Everything a scroll-linked effect reads, all of it on the UI thread. */
export type ScrollSource = {
	/** Scroll offset along `orientation`; negative while rubber-banding at the start. */
	offset: SharedValue<number>;
	/** Content extent along `orientation`; 0 until measured. */
	contentSize: SharedValue<number>;
	/** Viewport extent along `orientation`; 0 until measured. */
	layoutSize: SharedValue<number>;
	orientation: ScrollOrientation;
	/**
	 * Present when the source came from `useScrollSource`; null from a Screen.
	 * Lets an effect `measureLayout` against the scroller.
	 */
	ref: AnimatedRef<ScrollViewInstance> | null;
};

export type UseScrollSourceOptions = {
	/** @default "vertical" */
	orientation?: ScrollOrientation;
	/** Worklets composed after the source has written its values. */
	onBeginDrag?: (event: ScrollEventFields) => void;
	onEndDrag?: (event: ScrollEventFields) => void;
	onMomentumBegin?: (event: ScrollEventFields) => void;
	onMomentumEnd?: (event: ScrollEventFields) => void;
};

/** Props to spread onto an `Animated.ScrollView` / `Animated.FlatList` / `Animated.SectionList`. */
export type ScrollSourceProps = {
	ref: AnimatedRef<ScrollViewInstance>;
	onScroll: ReturnType<typeof useAnimatedScrollHandler>;
	onLayout: (event: LayoutChangeEvent) => void;
	onContentSizeChange: (width: number, height: number) => void;
	scrollEventThrottle: 16;
};

export type UseScrollSourceResult = { source: ScrollSource; scrollProps: ScrollSourceProps };

/**
 * A scroll source for a scrollable that is not a `Screen` body — a horizontal
 * card row, a list inside a card, a sheet body — and the props that feed it.
 *
 * **Spread `scrollProps` onto the scrollable; nothing clones it for you.** A
 * wrapper that cloned its child to attach `onScroll` would collide with
 * Reanimated's handler composition and with every handler a scrollable already
 * owns. Spread them last, or compose your own `onLayout` with them by hand.
 *
 * **Sizes are measured on layout, not only on scroll.** `onLayout` and
 * `onContentSizeChange` write `layoutSize` and `contentSize` as soon as the
 * scrollable lays out, so an effect over a list too short to scroll is right
 * before anyone touches it — a `Screen`'s source cannot do that, and an edge
 * fade over a short Screen body waits for the first scroll event.
 *
 * `orientation` is fixed here, by whoever creates the source, so no effect can
 * disagree with the scroller about which axis it moves on.
 *
 * @example
 * const { source, scrollProps } = useScrollSource({ orientation: "horizontal" });
 *
 * <ScrollFade scrollSource={source}>
 *   <Animated.ScrollView horizontal {...scrollProps}>{cards}</Animated.ScrollView>
 * </ScrollFade>
 */
export function useScrollSource(options: UseScrollSourceOptions = {}): UseScrollSourceResult {
	const { orientation = "vertical", onBeginDrag, onEndDrag, onMomentumBegin, onMomentumEnd } = options;
	const ref = useAnimatedRef<ScrollViewInstance>();
	const offset = useSharedValue(0);
	const contentSize = useSharedValue(0);
	const layoutSize = useSharedValue(0);

	const onScroll = useAnimatedScrollHandler({
		onScroll: (event) => {
			const reading = readScrollEvent(event, orientation);
			offset.value = reading.offset;
			if (reading.contentSize !== contentSize.value) contentSize.value = reading.contentSize;
			if (reading.layoutSize !== layoutSize.value) layoutSize.value = reading.layoutSize;
		},
		onBeginDrag: (event) => {
			offset.value = readScrollEvent(event, orientation).offset;
			onBeginDrag?.(event);
		},
		onEndDrag: (event) => {
			offset.value = readScrollEvent(event, orientation).offset;
			onEndDrag?.(event);
		},
		onMomentumBegin: (event) => {
			offset.value = readScrollEvent(event, orientation).offset;
			onMomentumBegin?.(event);
		},
		onMomentumEnd: (event) => {
			offset.value = readScrollEvent(event, orientation).offset;
			onMomentumEnd?.(event);
		},
	});

	const onLayout = useCallback(
		(event: LayoutChangeEvent) => {
			const { width, height } = event.nativeEvent.layout;
			layoutSize.value = orientation === "horizontal" ? width : height;
		},
		[orientation, layoutSize]
	);

	const onContentSizeChange = useCallback(
		(width: number, height: number) => {
			contentSize.value = orientation === "horizontal" ? width : height;
		},
		[orientation, contentSize]
	);

	return useMemo(
		() => ({
			source: { offset, contentSize, layoutSize, orientation, ref },
			scrollProps: { ref, onScroll, onLayout, onContentSizeChange, scrollEventThrottle: 16 },
		}),
		[offset, contentSize, layoutSize, orientation, ref, onScroll, onLayout, onContentSizeChange]
	);
}

const ScrollSourceContext = createContext<ScrollSource | null>(null);

export type ScrollSourceProviderProps = {
	source: ScrollSource;
	children: ReactNode;
};

/**
 * Publishes a scroll source to every scroll-linked effect beneath it, so none
 * of them needs a `scrollSource` prop. A `Screen` mounts one around its body
 * already; mount one by hand to share a single scrollable's source with several
 * effects, or with an effect a few components away from the list.
 */
export function ScrollSourceProvider({ source, children }: ScrollSourceProviderProps): ReactElement {
	return <ScrollSourceContext value={source}>{children}</ScrollSourceContext>;
}
ScrollSourceProvider.displayName = "DelacourUI.ScrollSourceProvider";

/** The nearest provider's source, or null. For an effect that can work without one. */
export function useScrollSourceContext(): ScrollSource | null {
	return use(ScrollSourceContext);
}

/**
 * The source a scroll-linked effect follows: the one it was given, else the
 * nearest `ScrollSourceProvider` (a `Screen` counts), else a thrown error
 * naming the component — an effect with nothing to follow would silently draw
 * its resting state forever.
 */
export function useResolvedScrollSource(component: string, explicit?: ScrollSource): ScrollSource {
	const ambient = useScrollSourceContext();
	const source = explicit ?? ambient;
	if (!source) {
		throw new Error(
			`\`${component}\` must be given a \`scrollSource\` or rendered inside a Screen / ScrollSourceProvider.`
		);
	}
	return source;
}
