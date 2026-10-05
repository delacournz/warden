import { KeyboardAwareLegendList } from "@legendapp/list/keyboard";
import type { LegendListProps, LegendListRef, LegendListRenderItemProps } from "@legendapp/list/react-native";
import type { AnimatedLegendListProps } from "@legendapp/list/reanimated";
import {
	type ForwardedRef,
	forwardRef,
	type ReactElement,
	type ReactNode,
	type Ref,
	type RefAttributes,
	useCallback,
	useEffect,
	useMemo,
	useRef,
} from "react";
import { FlatList, type FlatListProps, type ScrollViewProps, View } from "react-native";
import { KeyboardChatScrollView, type KeyboardChatScrollViewProps } from "react-native-keyboard-controller";
import Animated, { type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";
import { cn } from "@/lib/cn";
import { composeRefs } from "@/lib/compose-refs";
import { useScreenDebug } from "./screen.context";
import type { ScreenScrollableProps } from "./screen.types";
import { SCREEN_DEBUG_COLORS } from "./screen-debug";
import { resolveListComponent } from "./screen-list-component";
import {
	type ChatComposerSpacer,
	useChatComposerBaseSpacerHeight,
	useChatComposerGrowthPadding,
	useScreenScrollInsets,
} from "./use-screen-scroll-insets";

// `Animated.createAnimatedComponent` erases the generic parameters; the recast
// puts them back.
const AnimatedFlatList = Animated.createAnimatedComponent(FlatList) as unknown as typeof FlatList;

/** See the note on the same shape in `screen-legend-list` — the wrapper collapses `<ItemT>`. */
type StyledKeyboardAwareLegendListComponent = <ItemT>(
	props: Omit<
		AnimatedLegendListProps<ItemT>,
		"anchoredEndSpace" | "contentInsetEndAdjustment" | "renderScrollComponent"
	> &
		ChatKeyboardProps & {
			ref?: Ref<LegendListRef>;
			className?: string;
			contentContainerClassName?: string;
			contentInsetEndAdjustment?: SharedValue<number>;
			keyboardOffset?: number;
			keyboardDismissMode?: ScrollViewProps["keyboardDismissMode"];
			keyboardShouldPersistTaps?: ScrollViewProps["keyboardShouldPersistTaps"];
			showsVerticalScrollIndicator?: boolean;
			automaticallyAdjustContentInsets?: boolean;
			contentInsetAdjustmentBehavior?: ScrollViewProps["contentInsetAdjustmentBehavior"];
			contentContainerStyle?: ScrollViewProps["contentContainerStyle"];
			style?: ScrollViewProps["style"];
			onScroll?: ScrollViewProps["onScroll"];
		}
) => ReactElement | null;

// Third-party, so `className` needs the wrapper, built once at module scope.
const StyledKeyboardAwareLegendList = withUniwind(
	KeyboardAwareLegendList
) as unknown as StyledKeyboardAwareLegendListComponent;

/**
 * A chat gets the horizontal gutter but no vertical padding of its own.
 *
 * Its bubbles carry their own vertical rhythm, and both ends are already spoken
 * for: the navbar spacer at the top and a composer clearance at the bottom that
 * is computed to the point. Padding the container would push the newest message
 * off that reserve.
 */
const CHAT_CONTENT_CLASS = "px-screen-gutter";

/** How the keyboard moves a chat list, shared by both variants. */
type ChatKeyboardProps = {
	/**
	 * Distance from the bottom of the screen to the list. The keyboard pushes
	 * content by `keyboardHeight - offset` rather than the full height, so this
	 * is what stops the lift overshooting past a footer. Defaults to the
	 * safe-area inset.
	 */
	offset?: number;
	keyboardLiftBehavior?: KeyboardChatScrollViewProps["keyboardLiftBehavior"];
	freeze?: KeyboardChatScrollViewProps["freeze"];
	applyWorkaroundForContentInsetHitTestBug?: KeyboardChatScrollViewProps["applyWorkaroundForContentInsetHitTestBug"];
};

/** What both chat variants accept, regardless of which engine draws the rows. */
type ChatListSharedProps = ScreenScrollableProps &
	ChatKeyboardProps & {
		/**
		 * Collapsed height of the `Screen.Footer` CONTENT box — excluding the
		 * footer's own padding and the safe area.
		 *
		 * Seeds the composer clearance so the list's FIRST layout already clears
		 * the composer. The measured height corrects it a commit later if the two
		 * disagree, but by then the list has already scrolled to the end against
		 * the wrong reserve — which is why the newest message hides under the
		 * composer only sometimes. Pass this whenever the collapsed height is a
		 * known constant.
		 */
		composerBaseHeight?: number;
	};

export type ScreenChatListFlatProps<ItemT> = ChatListSharedProps &
	Omit<FlatListProps<ItemT>, "children" | "inverted" | "onScroll"> & {
		/** An inverted `FlatList`. Data must be newest-first. */
		variant: "flat";
		inverted?: boolean;
		/**
		 * Override the scroll range a growing input adds.
		 * @default the composer's growth above its own baseline, from the screen context
		 */
		extraContentPadding?: KeyboardChatScrollViewProps["extraContentPadding"];
		blankSpace?: KeyboardChatScrollViewProps["blankSpace"];
	};

export type ScreenChatListLegendProps<ItemT> = ChatListSharedProps &
	Omit<
		AnimatedLegendListProps<ItemT>,
		"anchoredEndSpace" | "contentInsetEndAdjustment" | "renderScrollComponent" | "onScroll"
	> & {
		/** LegendList in chat layout, with chronological oldest-first data. The default. */
		variant?: "legend";
		/**
		 * Override the padding that overlay growth adds above the collapsed
		 * baseline.
		 * @default the footer's overlay height from the screen context
		 */
		contentInsetEndAdjustment?: SharedValue<number>;
	};

export type ScreenChatListProps<ItemT> = ScreenChatListFlatProps<ItemT> | ScreenChatListLegendProps<ItemT>;

/**
 * One name, two ref types, correlated with `variant`.
 *
 * `forwardRef<T, P>` has a single `T`, so the correlation cannot be expressed by
 * the render function — it is stated here and re-established by a cast per
 * branch inside it. Those casts are the price of `forwardRef` on a discriminated
 * union: nothing checks them, so these two arms and those two branches are
 * edited together or not at all.
 */
type ScreenChatListComponent = (<ItemT>(
	props:
		| (ScreenChatListFlatProps<ItemT> & RefAttributes<FlatList<ItemT>>)
		| (ScreenChatListLegendProps<ItemT> & RefAttributes<LegendListRef>)
) => ReactElement) & { displayName?: string };

/**
 * A conversation list: composer clearance, keyboard lift and end anchoring.
 *
 * Two engines behind one name, chosen by `variant`, because the two ways to
 * build a chat list differ in what their data means rather than only in how
 * they draw:
 *
 * - `legend` (default) — LegendList in chat layout, chronological oldest-first
 *   data, anchored at the end. `renderItem` takes LegendList's own info object.
 *   Its ref is a `LegendListRef`.
 * - `flat` — an inverted `FlatList`, newest-first data, header and footer
 *   spacers swapped so the composer clearance stays adjacent to the composer.
 *   `renderItem` takes React Native's `ListRenderItemInfo`. Its ref is the
 *   inverted `FlatList` itself.
 *
 * The two `renderItem` contracts are genuinely different, so the union exposes
 * each engine's own rather than adapting one into the other — an adapter would
 * have to fabricate the `separators` object React Native's signature promises,
 * and nothing would honour it.
 *
 * Composer clearance is a static layout spacer, not a content inset: the list
 * scrolls to the end on its first layout, and an inset applied afterwards
 * arrives too late to be part of that. Live growth and keyboard motion stay on
 * the UI thread through `extraContentPadding` / `contentInsetEndAdjustment`.
 */
export const ScreenChatList = forwardRef(function ScreenChatListRender<ItemT>(
	props: ScreenChatListProps<ItemT>,
	ref: ForwardedRef<FlatList<ItemT> | LegendListRef>
): ReactElement {
	if (props.variant === "flat") {
		return <ScreenChatListFlat {...props} ref={ref as unknown as ForwardedRef<FlatList<ItemT>>} />;
	}
	return <ScreenChatListLegend {...props} ref={ref as unknown as ForwardedRef<LegendListRef>} />;
}) as unknown as ScreenChatListComponent;
ScreenChatList.displayName = "DelacourUI.Screen.ChatList";

/**
 * The composer clearance, as two separately visible bands.
 *
 * Two views rather than one total: under `<Screen debug>` the `occupancy`
 * band is EXACTLY what the footer covers, so its edge must land on the
 * footer's own. A single lumped spacer would hide a shortfall inside itself.
 *
 * An inverted list renders its header and footer contents bottom-to-top, so the
 * order flips to keep `occupancy` the band adjacent to the composer.
 */
function useComposerSpacerNode(spacer: ChatComposerSpacer, isInverted: boolean, debug: boolean): ReactNode {
	return useMemo(() => {
		const bands = [
			<View
				key="gap"
				style={[{ height: spacer.gap }, debug ? { backgroundColor: SCREEN_DEBUG_COLORS.listComposerGap } : null]}
			/>,
			<View
				key="occupancy"
				style={[
					{ height: spacer.occupancy },
					debug ? { backgroundColor: SCREEN_DEBUG_COLORS.listComposerSpacer } : null,
				]}
			/>,
		];
		return <>{isInverted ? bands.reverse() : bands}</>;
	}, [spacer.gap, spacer.occupancy, isInverted, debug]);
}

/** The flat variant's own type, restated so `<ItemT>` survives `forwardRef`. */
type ScreenChatListFlatComponent = (<ItemT>(
	props: ScreenChatListFlatProps<ItemT> & RefAttributes<FlatList<ItemT>>
) => ReactElement) & { displayName?: string };

const ScreenChatListFlat = forwardRef(function ScreenChatListFlatRender<ItemT>(
	{
		header,
		className,
		contentContainerClassName,
		composerBaseHeight,
		inverted = true,
		offset: offsetProp,
		keyboardLiftBehavior,
		freeze,
		applyWorkaroundForContentInsetHitTestBug,
		extraContentPadding: extraContentPaddingProp,
		blankSpace,
		ListHeaderComponent: ListHeaderComponentProp,
		ListFooterComponent: ListFooterComponentProp,
		contentContainerStyle,
		...props
	}: ScreenChatListFlatProps<ItemT>,
	ref: ForwardedRef<FlatList<ItemT>>
): ReactElement {
	const { scrollHandler, insetTopAnimatedStyle } = useScreenScrollInsets("chat");
	const composerSpacer = useChatComposerBaseSpacerHeight(composerBaseHeight);
	const composerGrowthPadding = useChatComposerGrowthPadding();
	const { bottom } = useSafeAreaInsets();
	const debug = useScreenDebug();

	const isInverted = Boolean(inverted);
	// The occupancy maths assumes the lift is short by exactly the safe-area
	// band: `KeyboardChatScrollView` scrolls by `keyboardHeight - offset`, and
	// that band is the one the sticky footer parks behind the keyboard. Lifting
	// by the full height instead leaves the newest message an inset too high.
	const offset = offsetProp ?? bottom;
	const extraContentPadding = extraContentPaddingProp ?? composerGrowthPadding;
	const composerSpacerNode = useComposerSpacerNode(composerSpacer, isInverted, debug);
	const topSpacerDebugStyle = debug ? { backgroundColor: SCREEN_DEBUG_COLORS.listTopSpacer } : null;

	const renderScrollComponent = useCallback(
		(scrollProps: ScrollViewProps) => (
			<KeyboardChatScrollView
				{...scrollProps}
				applyWorkaroundForContentInsetHitTestBug={applyWorkaroundForContentInsetHitTestBug}
				// iOS's own inset adjustment fights the composer clearance this list
				// manages itself, and the two compound into a drifting bottom gap.
				automaticallyAdjustContentInsets={false}
				blankSpace={blankSpace}
				contentInsetAdjustmentBehavior="never"
				extraContentPadding={extraContentPadding}
				freeze={freeze}
				inverted={isInverted}
				keyboardDismissMode="interactive"
				keyboardLiftBehavior={keyboardLiftBehavior}
				offset={offset}
			/>
		),
		[
			applyWorkaroundForContentInsetHitTestBug,
			blankSpace,
			extraContentPadding,
			freeze,
			isInverted,
			keyboardLiftBehavior,
			offset,
		]
	);

	const ListHeaderComponent = useMemo<ReactElement>(() => {
		const userHeader = resolveListComponent(ListHeaderComponentProp);
		// Inverted, the list header renders at the visual BOTTOM — beside the
		// composer — so the clearance belongs here rather than in the footer.
		if (isInverted) {
			return (
				<>
					{userHeader}
					{composerSpacerNode}
				</>
			);
		}
		return (
			<>
				<Animated.View style={[insetTopAnimatedStyle, topSpacerDebugStyle]} />
				{header}
				{userHeader}
			</>
		);
	}, [isInverted, ListHeaderComponentProp, header, insetTopAnimatedStyle, topSpacerDebugStyle, composerSpacerNode]);

	const ListFooterComponent = useMemo<ReactElement>(() => {
		const userFooter = resolveListComponent(ListFooterComponentProp);
		// Inverted, the list footer renders at the visual TOP, under the navbar.
		if (isInverted) {
			return (
				<View>
					<Animated.View style={[insetTopAnimatedStyle, topSpacerDebugStyle]} />
					{header}
					{userFooter}
				</View>
			);
		}
		return (
			<View>
				{userFooter}
				{composerSpacerNode}
			</View>
		);
	}, [isInverted, ListFooterComponentProp, header, insetTopAnimatedStyle, topSpacerDebugStyle, composerSpacerNode]);

	return (
		<AnimatedFlatList
			className={className}
			keyboardShouldPersistTaps="handled"
			showsVerticalScrollIndicator={false}
			{...props}
			contentContainerClassName={cn(CHAT_CONTENT_CLASS, contentContainerClassName)}
			contentContainerStyle={
				debug ? [contentContainerStyle, { backgroundColor: SCREEN_DEBUG_COLORS.listContent }] : contentContainerStyle
			}
			inverted={isInverted}
			ListFooterComponent={ListFooterComponent}
			ListHeaderComponent={ListHeaderComponent}
			onScroll={scrollHandler}
			ref={ref}
			renderScrollComponent={renderScrollComponent}
		/>
	);
}) as unknown as ScreenChatListFlatComponent;
ScreenChatListFlat.displayName = "DelacourUI.Screen.ChatList.Flat";

/** The legend variant's own type, restated so `<ItemT>` survives `forwardRef`. */
type ScreenChatListLegendComponent = (<ItemT>(
	props: ScreenChatListLegendProps<ItemT> & RefAttributes<LegendListRef>
) => ReactElement) & { displayName?: string };

const ScreenChatListLegend = forwardRef(function ScreenChatListLegendRender<ItemT>(
	{
		header,
		className,
		contentContainerClassName,
		composerBaseHeight,
		offset: offsetProp,
		keyboardLiftBehavior,
		freeze,
		applyWorkaroundForContentInsetHitTestBug,
		contentInsetEndAdjustment: contentInsetEndAdjustmentProp,
		ListHeaderComponent: ListHeaderComponentProp,
		ListFooterComponent: ListFooterComponentProp,
		contentContainerStyle,
		// A homogeneous list's rows all average out to one number. A list whose rows
		// run 40pt to 350pt must override this AND pass `getItemType`, or every
		// unmeasured row resolves to a single average spanning the whole range —
		// which is what makes a mixed list jump when a page of it prepends.
		estimatedItemSize = 72,
		alignItemsAtEnd = true,
		initialScrollAtEnd = true,
		maintainScrollAtEnd = true,
		maintainVisibleContentPosition,
		...props
	}: ScreenChatListLegendProps<ItemT>,
	ref: ForwardedRef<LegendListRef>
): ReactElement {
	const { insetTopAnimatedStyle, scrollHandler } = useScreenScrollInsets("chat");
	const composerSpacer = useChatComposerBaseSpacerHeight(composerBaseHeight);
	const composerGrowthPadding = useChatComposerGrowthPadding();
	const { bottom } = useSafeAreaInsets();
	const debug = useScreenDebug();

	// Same reasoning as the flat variant: the lift is deliberately short by the
	// safe-area band the sticky footer hides behind the keyboard.
	const keyboardOffset = offsetProp ?? bottom;
	const composerSpacerNode = useComposerSpacerNode(composerSpacer, false, debug);
	const contentInsetEndAdjustment = contentInsetEndAdjustmentProp ?? composerGrowthPadding;

	const ListHeaderComponent = useMemo<ReactElement>(
		() => (
			<>
				<Animated.View
					style={[insetTopAnimatedStyle, debug ? { backgroundColor: SCREEN_DEBUG_COLORS.listTopSpacer } : null]}
				/>
				{header}
				{resolveListComponent(ListHeaderComponentProp)}
			</>
		),
		[ListHeaderComponentProp, header, insetTopAnimatedStyle, debug]
	);

	const ListFooterComponent = useMemo<ReactElement>(
		() => (
			<>
				{resolveListComponent(ListFooterComponentProp)}
				{composerSpacerNode}
			</>
		),
		[ListFooterComponentProp, composerSpacerNode]
	);

	// Fallback for a seed that turned out wrong, or absent. When the baseline
	// spacer GROWS, the content the list was anchored to has shifted up by that
	// much — re-pin to the end, but only if the list was already parked there, so
	// a reader scrolled up into history is never yanked back down. With a correct
	// `composerBaseHeight` this never fires; if it does, the seed is stale.
	const innerRef = useRef<LegendListRef | null>(null);
	const previousSpacerRef = useRef(composerSpacer.total);

	useEffect(() => {
		const previous = previousSpacerRef.current;
		previousSpacerRef.current = composerSpacer.total;
		if (composerSpacer.total <= previous) return;

		const state = innerRef.current?.getState();
		if (!state?.isAtEnd && !state?.isWithinMaintainScrollAtEndThreshold) return;

		// One frame of slack: LegendList picks the new footer size up in ITS own
		// footer `onLayout`, which runs after this commit's native layout, so
		// scrolling now would target the stale size.
		const frame = requestAnimationFrame(() => {
			void innerRef.current?.scrollToEnd({ animated: false });
		});
		return () => cancelAnimationFrame(frame);
	}, [composerSpacer.total]);

	// Memoised, not called inline: `composeRefs` mints a new callback per call,
	// and React detaches and reattaches a ref whose identity changed. On a chat
	// list that would null `innerRef` and re-resolve the native handle on every
	// render, so the `scrollToEnd` above could fire against a ref mid-swap.
	const setRef = useMemo(() => composeRefs(innerRef, ref), [ref]);

	return (
		<StyledKeyboardAwareLegendList
			automaticallyAdjustContentInsets={false}
			className={className}
			contentInsetAdjustmentBehavior="never"
			keyboardDismissMode="interactive"
			keyboardShouldPersistTaps="handled"
			showsVerticalScrollIndicator={false}
			{...(props as AnimatedLegendListProps<ItemT>)}
			alignItemsAtEnd={alignItemsAtEnd}
			applyWorkaroundForContentInsetHitTestBug={applyWorkaroundForContentInsetHitTestBug}
			contentContainerClassName={cn(CHAT_CONTENT_CLASS, contentContainerClassName)}
			contentContainerStyle={
				debug ? [contentContainerStyle, { backgroundColor: SCREEN_DEBUG_COLORS.listContent }] : contentContainerStyle
			}
			contentInsetEndAdjustment={contentInsetEndAdjustment}
			estimatedItemSize={estimatedItemSize}
			freeze={freeze}
			initialScrollAtEnd={initialScrollAtEnd}
			keyboardLiftBehavior={keyboardLiftBehavior}
			keyboardOffset={keyboardOffset}
			ListFooterComponent={ListFooterComponent}
			ListHeaderComponent={ListHeaderComponent}
			maintainScrollAtEnd={maintainScrollAtEnd}
			// `data: true` keeps the scroll stable when older pages prepend.
			// `size` MUST stay off: size stabilisation reacts to the animated
			// keyboard and composer inset changes and compounds against
			// `maintainScrollAtEnd`'s end anchoring, intermittently shoving the
			// whole list out of the viewport.
			maintainVisibleContentPosition={maintainVisibleContentPosition ?? { data: true, size: false }}
			onScroll={scrollHandler}
			ref={setRef}
		/>
	);
}) as unknown as ScreenChatListLegendComponent;
ScreenChatListLegend.displayName = "DelacourUI.Screen.ChatList.Legend";

/** Re-exported so a caller can type its own `renderItem` for the legend variant. */
export type { LegendListProps, LegendListRef, LegendListRenderItemProps };
