import { BottomSheet as Headless } from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { Text, type TextPresetProps } from "@/components/ui/text";
import { bottomSheetVariants } from "./bottom-sheet.variants";

export type BottomSheetTitleProps = TextPresetProps;

/**
 * The sheet's heading.
 *
 * *Is* a `Text.Header` — the engine's `Title asChild` hands it the `nativeID`
 * the panel is labelled by, so focus entering the sheet announces its purpose
 * first, and the preset supplies the type. This adds layout, never a size or a
 * weight of its own, the same trade `Field.Label` makes with `Text.Label`; a
 * `text-lg font-semibold` here would be a second definition of that preset
 * which could drift from it, and the tests assert the slot carries neither.
 *
 * @example
 * <BottomSheet.Title>Keep yourself safe</BottomSheet.Title>
 */
export function BottomSheetTitle({ className, ...props }: BottomSheetTitleProps): ReactElement {
	return (
		<Headless.Title asChild>
			<Text.Header className={bottomSheetVariants().title({ className })} {...props} />
		</Headless.Title>
	);
}
BottomSheetTitle.displayName = "DelacourUI.BottomSheet.Title";
