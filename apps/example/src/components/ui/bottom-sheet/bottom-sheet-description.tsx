import { BottomSheet as Headless } from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { cn } from "@/lib/cn";
import { Text, type TextPresetProps } from "@/components/ui/text";

export type BottomSheetDescriptionProps = TextPresetProps;

/**
 * Supporting copy under the sheet's title.
 *
 * *Is* a `Text.Paragraph`, defaulting to the muted token — the title is what the
 * sheet is about and this is what it means, so the two need to read as a
 * hierarchy rather than as two equal lines. `color` is an ordinary prop, so a
 * description that needs the page colour asks for it. The engine's
 * `Description asChild` gives it the `nativeID` a skin can describe the panel by.
 *
 * It has no slot in `bottomSheetVariants`, and that is deliberate: it carries no
 * layout of its own, and `tv` emits `undefined` for an empty class string, so a
 * slot here would be one nothing could assert against.
 *
 * @example
 * <BottomSheet.Description>Update to the latest version.</BottomSheet.Description>
 */
export function BottomSheetDescription({
	className,
	color = "muted",
	...props
}: BottomSheetDescriptionProps): ReactElement {
	return (
		<Headless.Description asChild>
			<Text.Paragraph className={cn(className)} color={color} {...props} />
		</Headless.Description>
	);
}
BottomSheetDescription.displayName = "DelacourUI.BottomSheet.Description";
