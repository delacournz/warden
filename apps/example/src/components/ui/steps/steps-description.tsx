import type { ReactElement } from "react";
import { Text, type TextPresetProps } from "@/components/ui/text";
import { useStepsItemPart } from "./steps.context";
import { STEPS_DESCRIPTION_TEXT_SIZE, stepsVariants } from "./steps.variants";

export type StepsDescriptionProps = TextPresetProps;

/**
 * A line of supporting text under the title. Optional.
 *
 * Renders `Text.Caption` one size step below the title and keeps the preset's
 * muted colour in every state — the indicator and the title already say where
 * the step stands, and a third voice saying it would only be louder.
 */
export function StepsDescription({ className, size, ...props }: StepsDescriptionProps): ReactElement {
	const item = useStepsItemPart("Steps.Description");

	return (
		<Text.Caption
			className={stepsVariants({ orientation: item.orientation }).description({ className })}
			size={size ?? STEPS_DESCRIPTION_TEXT_SIZE[item.size]}
			{...props}
		/>
	);
}
StepsDescription.displayName = "DelacourUI.Steps.Description";
