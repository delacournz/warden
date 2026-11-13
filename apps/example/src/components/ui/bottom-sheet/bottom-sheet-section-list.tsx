import {
	BottomSheet as Headless,
	type BottomSheetSectionListProps as HeadlessProps,
	useBottomSheetInternal,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement, Ref } from "react";
import type { SectionList } from "react-native";
import { withUniwind } from "uniwind";
import { cn } from "@/lib/cn";
import { BOTTOM_SHEET_FOOTER_GAP, bottomSheetVariants } from "./bottom-sheet.variants";

/** The class props restated so `<ItemT, SectionT>` survive `withUniwind` — see `bottom-sheet-flat-list.tsx`. */
type StyledSectionListComponent = <ItemT, SectionT>(
	props: HeadlessProps<ItemT, SectionT> & {
		ref?: Ref<SectionList<ItemT, SectionT>>;
		className?: string;
		contentContainerClassName?: string;
	}
) => ReactElement | null;

// Built at module scope, or every render mints a new component type and
// remounts the list.
const StyledSectionList = withUniwind(Headless.SectionList) as unknown as StyledSectionListComponent;

export type BottomSheetSectionListProps<ItemT, SectionT> = HeadlessProps<ItemT, SectionT> & {
	ref?: Ref<SectionList<ItemT, SectionT>>;
	className?: string;
	/** Classes for the content container. Same gutter and gap as `Content`. */
	contentContainerClassName?: string;
};

/**
 * A virtualised body with sticky section headers.
 *
 * The engine's `SectionList` with the library's gutter on the content
 * container, for the same reasons `BottomSheet.FlatList` gives.
 *
 * @example
 * <BottomSheet.SectionList sections={sections} renderItem={renderRow} renderSectionHeader={renderHeader} />
 */
export function BottomSheetSectionList<ItemT, SectionT>({
	className,
	contentContainerClassName,
	contentContainerStyle,
	...props
}: BottomSheetSectionListProps<ItemT, SectionT>): ReactElement {
	const { hasFooter } = useBottomSheetInternal();

	return (
		<StyledSectionList
			className={cn(className)}
			contentContainerClassName={bottomSheetVariants().scrollContent({ className: contentContainerClassName })}
			contentContainerStyle={[{ paddingBottom: hasFooter ? BOTTOM_SHEET_FOOTER_GAP : 0 }, contentContainerStyle]}
			{...props}
		/>
	);
}
BottomSheetSectionList.displayName = "DelacourUI.BottomSheet.SectionList";
