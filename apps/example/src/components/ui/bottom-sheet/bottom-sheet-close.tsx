import { BottomSheet as Headless } from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { IconCrossSmall } from "@/lib/icons/central";
import { Icon } from "@/components/ui/icon";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { BOTTOM_SHEET_CLOSE_HIT_SLOP, bottomSheetVariants } from "./bottom-sheet.variants";

export type BottomSheetCloseProps = Omit<PressableProps, "asChild" | "busy" | "children" | "disabled">;

/**
 * The sheet's dismiss control.
 *
 * The engine's `Close asChild` around this library's `Pressable`, so the press
 * is the library's — `fade` rather than a spring, because a scale on a glyph
 * this small reads as a jitter, the reason `Badge.CloseButton` presses the same
 * way — and the close is the engine's: the same path a swipe-down and a scrim
 * press take, so a caller has one `onOpenChange` to watch rather than three.
 *
 * Positioned out of the content's flow, in the top-right of the sheet, so it
 * does not push the title down or take a row of its own. `BottomSheet.Title`
 * reserves the clearance for it on every sheet — see `bottomSheetVariants`.
 * The slop is there because a bare glyph in a corner has no padded capsule to
 * bring it up to the 44pt minimum — the case `Checkbox` mints slop for.
 *
 * @example
 * <BottomSheet.Content>
 *   <BottomSheet.Close />
 *   <BottomSheet.Title>Filters</BottomSheet.Title>
 * </BottomSheet.Content>
 */
export function BottomSheetClose({
	accessibilityLabel = "Close",
	className,
	feedback = "fade",
	hitSlop = BOTTOM_SHEET_CLOSE_HIT_SLOP,
	onPress,
	...props
}: BottomSheetCloseProps): ReactElement {
	return (
		<Headless.Close accessibilityLabel={accessibilityLabel} asChild onPress={onPress}>
			<Pressable
				accessibilityRole="button"
				className={bottomSheetVariants().close({ className })}
				feedback={feedback}
				hitSlop={hitSlop}
				{...props}
			>
				<Icon color="muted-foreground" icon={IconCrossSmall} />
			</Pressable>
		</Headless.Close>
	);
}
BottomSheetClose.displayName = "DelacourUI.BottomSheet.Close";
