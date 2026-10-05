import type { ReactElement } from "react";
import { View } from "react-native";
import type { StepConnectorSlot, StepsOrientation } from "./steps.variants";
import { stepsVariants } from "./steps.variants";

export type StepsConnectorProps = {
	slot: Exclude<StepConnectorSlot, "none">;
	orientation: StepsOrientation;
	isComplete: boolean;
};

/**
 * One half of the line between two steps, or the invisible half that keeps an
 * end indicator centred. Internal — nobody places one; see
 * `resolveStepConnectors`.
 *
 * Hidden from assistive technology, like `Separator`: the line restates the
 * status every step already announces.
 */
export function StepsConnector({ slot, orientation, isComplete }: StepsConnectorProps): ReactElement {
	const slots = stepsVariants({ isConnectorComplete: isComplete, orientation });

	return (
		<View
			accessibilityElementsHidden
			className={slot === "spacer" ? slots.spacer() : slots.connector()}
			importantForAccessibility="no-hide-descendants"
		/>
	);
}
StepsConnector.displayName = "DelacourUI.Steps.Connector";
