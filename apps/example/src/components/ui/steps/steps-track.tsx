import type { ReactElement, ReactNode } from "react";
import { View } from "react-native";
import { useStepsItemPart, useStepsPart } from "./steps.context";
import { isConnectorComplete, resolveStepConnectors, stepsVariants } from "./steps.variants";
import { StepsConnector } from "./steps-connector";
import { StepsIndicator } from "./steps-indicator";

/**
 * A step's track: `[leading] [indicator] [trailing]`. Internal.
 *
 * The leading half joins the previous step, so it fills off that step's index
 * rather than this one's — the two halves of one line must agree, and the value
 * is the only thing both can see. See `isConnectorComplete`.
 */
export function StepsTrack({ indicator }: { indicator: ReactNode | null }): ReactElement {
	const { value, count } = useStepsPart("Steps.Item");
	const { step, orientation, size, isLast } = useStepsItemPart("Steps.Item");
	const connectors = resolveStepConnectors({ count, orientation, step });

	return (
		<View className={stepsVariants({ isLast, orientation, size }).track()}>
			{connectors.leading === "none" ? null : (
				<StepsConnector
					isComplete={isConnectorComplete(step - 1, value)}
					orientation={orientation}
					slot={connectors.leading}
				/>
			)}
			{indicator ?? <StepsIndicator />}
			{connectors.trailing === "none" ? null : (
				<StepsConnector
					isComplete={isConnectorComplete(step, value)}
					orientation={orientation}
					slot={connectors.trailing}
				/>
			)}
		</View>
	);
}
StepsTrack.displayName = "DelacourUI.Steps.Item.Track";

/**
 * The column beside a vertical `Steps.Panel`, as wide as the indicator, that
 * carries the trailing line on past the panel. Internal.
 */
export function StepsRail(): ReactElement {
	const { value, count } = useStepsPart("Steps.Item");
	const { step, orientation, size, isLast } = useStepsItemPart("Steps.Item");
	const { trailing } = resolveStepConnectors({ count, orientation, step });

	return (
		<View className={stepsVariants({ hasPanel: true, isLast, orientation, size }).rail()}>
			{trailing === "line" ? (
				<StepsConnector isComplete={isConnectorComplete(step, value)} orientation={orientation} slot="line" />
			) : null}
		</View>
	);
}
StepsRail.displayName = "DelacourUI.Steps.Item.Rail";
