import {
	BottomSheet as Headless,
	type BottomSheetFlatListProps as HeadlessProps,
	useBottomSheetInternal,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement, Ref } from "react";
import type { FlatList } from "react-native";
import { withUniwind } from "uniwind";
import { cn } from "@/lib/cn";
import { BOTTOM_SHEET_FOOTER_GAP, bottomSheetVariants } from "./bottom-sheet.variants";

/**
 * The class props `withUniwind` adds, restated so the generic survives.
 *
 * `withUniwind`'s own return type maps over a component's props and collapses
 * `<ItemT>` in the process, which would leave `data` and `renderItem` checking
 * against `unknown`. Writing the signature out keeps inference and still
 * declares exactly the two props the wrapper adds — the same move
 * `Screen.LegendList` makes.
 */
type StyledFlatListComponent = <ItemT>(
	props: HeadlessProps<ItemT> & { ref?: Ref<FlatList<ItemT>>; className?: string; contentContainerClassName?: string }
) => ReactElement | null;

// Built at module scope, or every render mints a new component type and
// remounts the list.
const StyledFlatList = withUniwind(Headless.FlatList) as unknown as StyledFlatListComponent;

export type BottomSheetFlatListProps<ItemT> = HeadlessProps<ItemT> & {
	ref?: Ref<FlatList<ItemT>>;
	className?: string;
	/** Classes for the content container. Same gutter and gap as `Content`. */
	contentContainerClassName?: string;
};

/**
 * A virtualised body.
 *
 * The engine's `FlatList` — the scroll lock, the drag budget and content size
 * as the dynamic snap point are all its — with the library's gutter on the content
 * container. A virtualised list has no inner box to put the classes on, so
 * here they go on `contentContainerClassName`; the engine flattens the
 * resulting style to one object before the list measures it.
 *
 * @example
 * <BottomSheet.FlatList data={rows} keyExtractor={(row) => row.id} renderItem={renderRow} />
 */
export function BottomSheetFlatList<ItemT>({
	className,
	contentContainerClassName,
	contentContainerStyle,
	...props
}: BottomSheetFlatListProps<ItemT>): ReactElement {
	const { hasFooter } = useBottomSheetInternal();

	return (
		<StyledFlatList
			className={cn(className)}
			contentContainerClassName={bottomSheetVariants().scrollContent({ className: contentContainerClassName })}
			contentContainerStyle={[{ paddingBottom: hasFooter ? BOTTOM_SHEET_FOOTER_GAP : 0 }, contentContainerStyle]}
			{...props}
		/>
	);
}
BottomSheetFlatList.displayName = "DelacourUI.BottomSheet.FlatList";
