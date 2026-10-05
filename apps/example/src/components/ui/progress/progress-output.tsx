import type { ReactElement } from "react";
import { Text, type TextPresetProps } from "@/components/ui/text";
import { useProgressPart } from "./progress.context";
import type { ProgressRenderChildren } from "./progress.types";
import { PROGRESS_OUTPUT_TEXT_SIZE, progressVariants } from "./progress.variants";

export type ProgressOutputProps = Omit<TextPresetProps, "children"> & {
	/** Custom content, or a function called with the bar's settled state. */
	children?: ProgressRenderChildren;
};

/**
 * The current value, formatted — `72%` by default.
 *
 * A function child is handed the bar's state, which is how a count reads
 * `18 of 24` rather than a percentage.
 *
 * **Hidden from assistive technology on purpose.** The root already publishes
 * the value as `accessibilityValue`, so a readout left visible inside it would be
 * read twice — once as part of the element's name, once as its value.
 *
 * **An indeterminate bar has no value**, so the default readout renders nothing.
 * A function child still runs, which is where a "Waiting…" belongs.
 */
export function ProgressOutput({ children, className, size, ...props }: ProgressOutputProps): ReactElement | null {
	const { color, size: progressSize, isIndeterminate, renderProps } = useProgressPart("Progress.Output");

	const content =
		typeof children === "function"
			? children(renderProps)
			: (children ?? (isIndeterminate ? null : renderProps.formatted));

	if (content === null || content === undefined) return null;

	return (
		<Text.Label
			accessibilityElementsHidden
			className={progressVariants({ color, isIndeterminate, size: progressSize }).output({ className })}
			importantForAccessibility="no-hide-descendants"
			size={size ?? PROGRESS_OUTPUT_TEXT_SIZE[progressSize]}
			{...props}
		>
			{content}
		</Text.Label>
	);
}
ProgressOutput.displayName = "DelacourUI.Progress.Output";
