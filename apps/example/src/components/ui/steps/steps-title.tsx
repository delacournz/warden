import type { ReactElement } from "react";
import { Text, type TextPresetProps } from "@/components/ui/text";
import { useStepsItemPart } from "./steps.context";
import { STEPS_TITLE_TEXT_SIZE, stepsVariants } from "./steps.variants";

export type StepsTitleProps = TextPresetProps;

/**
 * The step's name — and, because the step is one accessibility element, its
 * accessible name too.
 *
 * Renders `Text.Label` at the step's own size step rather than a scale of its
 * own, the rule `Radio.Label` follows. Its colour follows the step: muted ahead
 * of the value, destructive while invalid. Bare text inside a `Steps.Item` is
 * wrapped in one automatically.
 */
export function StepsTitle({ className, size, ...props }: StepsTitleProps): ReactElement {
	const item = useStepsItemPart("Steps.Title");

	return (
		<Text.Label
			className={stepsVariants({
				isInvalid: item.isInvalid,
				orientation: item.orientation,
				status: item.status,
			}).title({ className })}
			size={size ?? STEPS_TITLE_TEXT_SIZE[item.size]}
			{...props}
		/>
	);
}
StepsTitle.displayName = "DelacourUI.Steps.Title";
