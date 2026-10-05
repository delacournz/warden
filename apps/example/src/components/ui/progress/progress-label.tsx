import type { ReactElement } from "react";
import { Text, type TextPresetProps } from "@/components/ui/text";
import { useProgressPart } from "./progress.context";
import { PROGRESS_OUTPUT_TEXT_SIZE, progressVariants } from "./progress.variants";

export type ProgressLabelProps = TextPresetProps;

/**
 * What the bar is measuring — "Uploading", "Storage".
 *
 * Renders `Text.Label` and names a size step, never a scale of its own, so the
 * weight and colour stay in the preset. It is left visible to assistive
 * technology: the root is one accessible element, and a label inside it is what
 * VoiceOver and TalkBack read as that element's name.
 */
export function ProgressLabel({ className, size, ...props }: ProgressLabelProps): ReactElement {
	const { color, size: progressSize, isIndeterminate } = useProgressPart("Progress.Label");
	return (
		<Text.Label
			className={progressVariants({ color, isIndeterminate, size: progressSize }).label({ className })}
			numberOfLines={1}
			size={size ?? PROGRESS_OUTPUT_TEXT_SIZE[progressSize]}
			{...props}
		/>
	);
}
ProgressLabel.displayName = "DelacourUI.Progress.Label";
