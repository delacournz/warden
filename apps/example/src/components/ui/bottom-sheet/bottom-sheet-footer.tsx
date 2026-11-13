import {
	BottomSheet as Headless,
	type BottomSheetFooterProps as HeadlessProps,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { withUniwind } from "uniwind";
import { BOTTOM_SHEET_FOOTER_PADDING, bottomSheetVariants } from "./bottom-sheet.variants";

type StyledFooterComponent = (props: HeadlessProps & { className?: string }) => ReactElement | null;

// Built once at module scope; the classes land on the engine's inner, measured
// view, after its own `padding`, so the gutter here wins the horizontal axis.
const StyledFooter = withUniwind(Headless.Footer) as unknown as StyledFooterComponent;

export type BottomSheetFooterProps = HeadlessProps & {
	className?: string;
};

/**
 * A row of controls at the bottom of the sheet — in the flow, or pinned.
 *
 * **`sticky` is off by default, matching `Screen.Footer`**, and that is the one
 * place this skin overrides the engine's default: a footer holding a submit
 * button under a short sheet wants to sit where it was written, and a sheet
 * only needs the pinned treatment once its body can scroll under one. Write a
 * pinned footer inside `Container`, after the body; an inline one inside the
 * body, where it should scroll.
 *
 * The two branches deliberately look different. An inline footer is in the
 * flow and inherits the sheet's surface; a pinned one draws OVER the content,
 * so it brings a background and a top hairline of its own — without them the
 * content scrolls straight through it. That is `Screen.Footer`'s rule about its
 * backing, one component along.
 *
 * Everything else is the engine's: a pinned footer is translated to the
 * geometry's footer line, which the core proves holds still through a keyboard
 * animation, so its buttons land on the keyboard's top edge without moving;
 * the safe-area band under it is a spacer the geometry owns; and its measured
 * height is what the body reserves and the dynamic snap point counts. The
 * `padding` goes to the engine rather than a class for that reason — it has to
 * be inside the measured box.
 *
 * @example
 * <BottomSheet.Container>
 *   <BottomSheet.Content>{fields}</BottomSheet.Content>
 *   <BottomSheet.Footer sticky>
 *     <Button onPress={save}>Save</Button>
 *   </BottomSheet.Footer>
 * </BottomSheet.Container>
 *
 * @example
 * // In the flow — inside the body, scrolling with it.
 * <BottomSheet.ScrollView>
 *   {copy}
 *   <BottomSheet.Footer>
 *     <Button>Continue</Button>
 *   </BottomSheet.Footer>
 * </BottomSheet.ScrollView>
 */
export function BottomSheetFooter({
	className,
	sticky = false,
	padding,
	...props
}: BottomSheetFooterProps): ReactElement {
	const slots = bottomSheetVariants();

	if (!sticky) {
		return <StyledFooter className={slots.footer({ className })} padding={padding} sticky={false} {...props} />;
	}

	return (
		<StyledFooter
			className={slots.stickyFooter({ className })}
			padding={padding ?? BOTTOM_SHEET_FOOTER_PADDING}
			sticky
			{...props}
		/>
	);
}
BottomSheetFooter.displayName = "DelacourUI.BottomSheet.Footer";
