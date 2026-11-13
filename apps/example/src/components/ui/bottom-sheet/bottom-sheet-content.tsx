import {
	BottomSheet as Headless,
	type BottomSheetContentProps as HeadlessProps,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { withUniwind } from "uniwind";
import { BOTTOM_SHEET_FOOTER_GAP, bottomSheetVariants } from "./bottom-sheet.variants";

type StyledContentComponent = (props: HeadlessProps & { className?: string }) => ReactElement | null;

// Built once at module scope; the classes land on the engine's inner, measured
// view, which is the one that takes `style`.
const StyledContent = withUniwind(Headless.Content) as unknown as StyledContentComponent;

export type BottomSheetContentProps = HeadlessProps & {
	className?: string;
};

/**
 * The sheet's body — what a caller writes the title, the copy and the controls
 * into.
 *
 * The engine's `Content` with the library's gutter and gap on its measured
 * box. Everything the old body had to do by hand is the engine's now: the
 * body is clamped to the space the handle, a sticky footer, the keyboard and
 * the safe-area band leave; a spacer the footer's height plus `footerGap`
 * keeps the last line above a pinned footer; and the band under it is
 * reserved by the geometry rather than padded here.
 *
 * @example
 * <BottomSheet.Content>
 *   <BottomSheet.Title>Delete this file?</BottomSheet.Title>
 *   <BottomSheet.Description>This cannot be undone.</BottomSheet.Description>
 * </BottomSheet.Content>
 */
export function BottomSheetContent({
	className,
	footerGap = BOTTOM_SHEET_FOOTER_GAP,
	...props
}: BottomSheetContentProps): ReactElement {
	return <StyledContent className={bottomSheetVariants().content({ className })} footerGap={footerGap} {...props} />;
}
BottomSheetContent.displayName = "DelacourUI.BottomSheet.Content";
