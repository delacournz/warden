import {
	type BottomSheetScrollableProps,
	createBottomSheetScrollable,
	SCROLLABLE_TYPE,
	useBottomSheetInternal,
} from "@delacour/react-native-bottom-sheet";
import type { LegendListRef } from "@legendapp/list/react-native";
import { AnimatedLegendList, type AnimatedLegendListProps } from "@legendapp/list/reanimated";
import type { ReactElement, Ref } from "react";
import { withUniwind } from "uniwind";
import { cn } from "@/lib/cn";
import { BOTTOM_SHEET_FOOTER_GAP, bottomSheetVariants } from "./bottom-sheet.variants";

/**
 * `AnimatedLegendList` as a sheet body.
 *
 * Made once at module scope, as the factory requires: the wrapper drives the
 * list with `animatedProps` and an animated `onScroll`, and a component made
 * inside a render is a new type every frame. Registered as a flat list, which
 * is what it is to the sheet — one scroll offset, one drag budget.
 */
const SheetLegendList = createBottomSheetScrollable(AnimatedLegendList, SCROLLABLE_TYPE.FLAT_LIST);

/** The class props restated so `<ItemT>` survives `withUniwind` — see `bottom-sheet-flat-list.tsx`. */
type StyledLegendListComponent = <ItemT>(
	props: AnimatedLegendListProps<ItemT> &
		BottomSheetScrollableProps & { ref?: Ref<LegendListRef>; className?: string; contentContainerClassName?: string }
) => ReactElement | null;

const StyledLegendList = withUniwind(SheetLegendList) as unknown as StyledLegendListComponent;

export type BottomSheetLegendListProps<ItemT> = Omit<AnimatedLegendListProps<ItemT>, "renderScrollComponent"> &
	BottomSheetScrollableProps & {
		ref?: Ref<LegendListRef>;
		className?: string;
		/** Classes for the content container. Same gutter and gap as `Content`. */
		contentContainerClassName?: string;
	};

/**
 * A `LegendList` body, for a list long enough that `FlatList`'s virtualisation
 * shows.
 *
 * Built here rather than in the engine because `@legendapp/list` is this
 * library's optional peer, not the engine's: the engine exports the factory,
 * and this is what the factory is for. The same scroll lock, drag budget and
 * content-size snap point as the other three bodies.
 *
 * @example
 * <BottomSheet.LegendList data={rows} keyExtractor={(row) => row.id} renderItem={renderRow} />
 */
export function BottomSheetLegendList<ItemT>({
	className,
	contentContainerClassName,
	contentContainerStyle,
	...props
}: BottomSheetLegendListProps<ItemT>): ReactElement {
	const { hasFooter } = useBottomSheetInternal();

	return (
		<StyledLegendList
			className={cn(className)}
			contentContainerClassName={bottomSheetVariants().scrollContent({ className: contentContainerClassName })}
			contentContainerStyle={[{ paddingBottom: hasFooter ? BOTTOM_SHEET_FOOTER_GAP : 0 }, contentContainerStyle]}
			{...props}
		/>
	);
}
BottomSheetLegendList.displayName = "DelacourUI.BottomSheet.LegendList";
