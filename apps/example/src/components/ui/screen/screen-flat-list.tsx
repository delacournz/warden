import { type ForwardedRef, forwardRef, type ReactElement, type RefAttributes, useMemo } from "react";
import { FlatList, type FlatListProps, View } from "react-native";
import Animated from "react-native-reanimated";
import { cn } from "@/lib/cn";
import type { ScreenScrollableProps } from "./screen.types";
import { screenVariants } from "./screen.variants";
import { resolveListComponent } from "./screen-list-component";
import { useScreenScrollInsets } from "./use-screen-scroll-insets";

// `Animated.createAnimatedComponent` erases the generic parameters; the recast
// puts them back so `data` and `renderItem` still check against each other.
const AnimatedFlatList = Animated.createAnimatedComponent(FlatList) as unknown as typeof FlatList;

export type ScreenFlatListProps<ItemT> = Omit<FlatListProps<ItemT>, "children"> & ScreenScrollableProps;

/**
 * The component's own type, restated so `<ItemT>` survives `forwardRef`.
 *
 * `forwardRef` erases type parameters — its result is a
 * `ForwardRefExoticComponent` over one concrete instantiation — so `data` and
 * `renderItem` would check against `unknown` and stop constraining each other.
 * Writing the signature out is the same move `StyledAnimatedLegendListComponent`
 * makes for `withUniwind` in `screen-legend-list`, and the `displayName` member
 * is what keeps the trailing assignment legal after the cast.
 */
type ScreenFlatListComponent = (<ItemT>(
	props: ScreenFlatListProps<ItemT> & RefAttributes<FlatList<ItemT>>
) => ReactElement) & { displayName?: string };

/**
 * A virtualised list that keeps its content clear of the screen's chrome.
 *
 * The reserves ride on `ListHeaderComponent` / `ListFooterComponent` rather
 * than on the content container's padding, because a virtualised list measures
 * its own content and a padded container would put the spacer outside what it
 * measures.
 *
 * A caller's own header and footer components still render — they are composed
 * inside the screen's, not replaced by them.
 *
 * The ref is the list itself, for `scrollToIndex`, `scrollToOffset` and the rest.
 */
export const ScreenFlatList = forwardRef(function ScreenFlatListRender<ItemT>(
	{
		header,
		contentContainerClassName,
		ListHeaderComponent: ListHeaderComponentProp,
		ListFooterComponent: ListFooterComponentProp,
		...props
	}: ScreenFlatListProps<ItemT>,
	ref: ForwardedRef<FlatList<ItemT>>
): ReactElement {
	const { scrollHandler, insetTopAnimatedStyle, insetBottomAnimatedStyle } = useScreenScrollInsets("standard");

	const ListHeaderComponent = useMemo<ReactElement>(
		() => (
			<>
				<Animated.View style={insetTopAnimatedStyle} />
				{header}
				{resolveListComponent(ListHeaderComponentProp)}
			</>
		),
		[header, ListHeaderComponentProp, insetTopAnimatedStyle]
	);

	const ListFooterComponent = useMemo<ReactElement>(
		() => (
			<View>
				{resolveListComponent(ListFooterComponentProp)}
				<Animated.View style={insetBottomAnimatedStyle} />
			</View>
		),
		[ListFooterComponentProp, insetBottomAnimatedStyle]
	);

	return (
		<AnimatedFlatList
			showsVerticalScrollIndicator={false}
			{...props}
			contentContainerClassName={cn(screenVariants().scrollContent(), contentContainerClassName)}
			ListFooterComponent={ListFooterComponent}
			ListHeaderComponent={ListHeaderComponent}
			onScroll={scrollHandler}
			ref={ref}
		/>
	);
}) as unknown as ScreenFlatListComponent;
ScreenFlatList.displayName = "DelacourUI.Screen.FlatList";
