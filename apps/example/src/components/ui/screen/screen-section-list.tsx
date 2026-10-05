import { type ForwardedRef, forwardRef, type ReactElement, type RefAttributes, useMemo } from "react";
import { type DefaultSectionT, SectionList, type SectionListProps, View } from "react-native";
import Animated from "react-native-reanimated";
import { cn } from "@/lib/cn";
import type { ScreenScrollableProps } from "./screen.types";
import { screenVariants } from "./screen.variants";
import { resolveListComponent } from "./screen-list-component";
import { useScreenScrollInsets } from "./use-screen-scroll-insets";

// `Animated.createAnimatedComponent` erases the generic parameters; the recast
// puts them back so `sections` and `renderItem` still check against each other.
const AnimatedSectionList = Animated.createAnimatedComponent(SectionList) as unknown as typeof SectionList;

export type ScreenSectionListProps<ItemT, SectionT = DefaultSectionT> = Omit<
	SectionListProps<ItemT, SectionT>,
	"children"
> &
	ScreenScrollableProps;

/**
 * The component's own type, restated so the generics survive `forwardRef`.
 *
 * Same reasoning as `ScreenFlatListComponent`: `forwardRef` erases type
 * parameters, so `sections` and `renderItem` would check against `unknown`.
 */
type ScreenSectionListComponent = (<ItemT, SectionT = DefaultSectionT>(
	props: ScreenSectionListProps<ItemT, SectionT> & RefAttributes<SectionList<ItemT, SectionT>>
) => ReactElement) & { displayName?: string };

/**
 * A sectioned virtualised list that keeps its content clear of the screen's
 * chrome. `Screen.FlatList`'s behaviour, with sticky section headers.
 *
 * The ref is the list itself, for `scrollToLocation` and the rest.
 */
export const ScreenSectionList = forwardRef(function ScreenSectionListRender<ItemT, SectionT = DefaultSectionT>(
	{
		header,
		contentContainerClassName,
		ListHeaderComponent: ListHeaderComponentProp,
		ListFooterComponent: ListFooterComponentProp,
		...props
	}: ScreenSectionListProps<ItemT, SectionT>,
	ref: ForwardedRef<SectionList<ItemT, SectionT>>
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
		<AnimatedSectionList
			showsVerticalScrollIndicator={false}
			{...props}
			contentContainerClassName={cn(screenVariants().scrollContent(), contentContainerClassName)}
			ListFooterComponent={ListFooterComponent}
			ListHeaderComponent={ListHeaderComponent}
			onScroll={scrollHandler}
			ref={ref}
		/>
	);
}) as unknown as ScreenSectionListComponent;
ScreenSectionList.displayName = "DelacourUI.Screen.SectionList";
