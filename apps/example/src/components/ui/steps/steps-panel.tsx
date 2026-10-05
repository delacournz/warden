import type { ReactElement } from "react";
import { View, type ViewProps } from "react-native";
import { useStepsItemPart } from "./steps.context";
import { stepsVariants } from "./steps.variants";

export type StepsPanelProps = ViewProps & { className?: string };

/**
 * Content for a step that sits below its title but outside its tap target — a
 * form for the current step, a summary of a finished one.
 *
 * **It exists because the trigger is one accessibility element.** The trigger
 * merges its indicator, title and description into a single stop, so a text
 * field or a button inside it would be unreachable by VoiceOver, and its own
 * tap gesture would sit inside the step's. The panel renders beside the
 * trigger instead: every control in it is its own element, and a press on it
 * never moves the stepper.
 *
 * Wherever it is written among a step's children, the step lifts it out and
 * renders it after the trigger. In a vertical stepper the line carries on down
 * a rail beside it, so the panel reads as part of its step. Show it
 * conditionally — `{value === 1 ? <Steps.Panel>…</Steps.Panel> : null}` — there
 * is no built-in "only while current", because a finished step's summary is as
 * common a panel as the current step's form.
 */
export function StepsPanel({ className, ...props }: StepsPanelProps): ReactElement {
	const item = useStepsItemPart("Steps.Panel");

	return (
		<View
			className={stepsVariants({
				hasPanel: true,
				isLast: item.isLast,
				orientation: item.orientation,
				size: item.size,
			}).panel({ className })}
			{...props}
		/>
	);
}
StepsPanel.displayName = "DelacourUI.Steps.Panel";
