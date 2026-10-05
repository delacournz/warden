import { Children, isValidElement, type ReactElement, type ReactNode, useCallback, useMemo } from "react";
import { View } from "react-native";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { type StepsItemContextValue, StepsItemProvider, useStepsPart } from "./steps.context";
import {
	resolveStepAccessibilityValue,
	resolveStepInteraction,
	resolveStepStatus,
	stepsVariants,
} from "./steps.variants";
import { StepsIndicator } from "./steps-indicator";
import { StepsPanel } from "./steps-panel";
import { StepsTitle } from "./steps-title";
import { StepsRail, StepsTrack } from "./steps-track";

export type StepsItemProps = Omit<PressableProps, "asChild" | "busy" | "children" | "disabled" | "ref"> & {
	/** This step's index, zero-based. The indicator draws it one-based. */
	step: number;
	/**
	 * Overrides whether the step reads as done. `true` completes it wherever it
	 * sits — a finished flow's last step. `false` leaves a passed step looking
	 * unfinished — a skipped optional one. Never demotes the current step.
	 */
	completed?: boolean;
	/** The step cannot be pressed, and fades. A stepper that names `isDisabled` wins over this. */
	isDisabled?: boolean;
	/** The step has an error: a cross in the indicator and a destructive title. */
	isInvalid?: boolean;
	/** A spinner in the indicator. The step is announced busy and cannot be pressed. */
	isLoading?: boolean;
	children?: ReactNode;
};

/**
 * One step: its indicator, the connector halves either side of it, its title and
 * description, and any `Steps.Panel`.
 *
 * The trigger is the control — the circle, the title and the space between them
 * are one tap target and one accessibility element, whose name is the title and
 * whose value is "Step 2 of 3, completed". It renders a `Pressable` when the
 * stepper takes presses and a plain `View` when it is read-only, so a progress
 * display is never announced as a row of buttons. A panel renders after the
 * trigger, outside both.
 *
 * `className` styles the step's outer box; every other prop — `testID`,
 * `onPress`, `haptic`, the accessibility props — reaches the trigger.
 *
 * Bare text is wrapped in a `Steps.Title`, and a `Steps.Indicator` is composed
 * in when the children hold none — the shortest step that works is
 * `<Steps.Item step={0}>Account</Steps.Item>`.
 */
export function StepsItem({
	step,
	completed,
	isDisabled,
	isInvalid = false,
	isLoading = false,
	feedback = "fade",
	haptic,
	onLongPress,
	pressedOpacity,
	pressedScale,
	accessibilityState,
	className,
	children,
	onPress,
	...props
}: StepsItemProps): ReactElement {
	const root = useStepsPart("Steps.Item");
	const { value, count, orientation, size, variant, select } = root;

	const status = resolveStepStatus({ completed, step, value });
	const isCurrent = step === value;
	const resolvedIsDisabled = root.isDisabled ?? isDisabled ?? false;
	const isLast = step >= count - 1;

	if (process.env.NODE_ENV !== "production" && count > 0 && (step < 0 || step >= count)) {
		console.warn(`Steps.Item: step ${step} is outside the ${count} steps the root counted. Steps are zero-based.`);
	}

	const interaction = resolveStepInteraction({
		isDisabled: resolvedIsDisabled,
		isLinear: root.isLinear,
		isLoading,
		isReadOnly: root.isReadOnly,
		step,
		value,
	});

	const context = useMemo<StepsItemContextValue>(
		() => ({
			isCurrent,
			isDisabled: resolvedIsDisabled,
			isInvalid,
			isLast,
			isLoading,
			orientation,
			size,
			status,
			step,
			variant,
		}),
		[isCurrent, resolvedIsDisabled, isInvalid, isLast, isLoading, orientation, size, status, step, variant]
	);

	const handlePress = useCallback(() => {
		select(step);
		onPress?.();
	}, [onPress, select, step]);

	const { indicator, content, panels } = useMemo(() => splitChildren(children), [children]);
	const hasPanel = panels.length > 0;
	const slots = stepsVariants({ hasPanel, isDisabled: resolvedIsDisabled, isLast, orientation, size });

	const trigger = (
		<>
			<StepsTrack indicator={indicator} />
			{content.length > 0 ? <View className={slots.content()}>{content}</View> : null}
		</>
	);

	// A vertical panel sits beside a rail that carries the line on past it; a
	// horizontal one simply follows the trigger.
	const panelRow =
		hasPanel && orientation === "vertical" ? (
			<View className={slots.panelRow()}>
				<StepsRail />
				{panels}
			</View>
		) : (
			panels
		);

	const accessibilityValue = {
		text: resolveStepAccessibilityValue({ count, isInvalid, isLoading, status, step }),
	};
	const state = { ...accessibilityState, selected: isCurrent };

	return (
		<StepsItemProvider value={context}>
			<View className={slots.item({ className })}>
				{interaction === "static" ? (
					<View
						accessibilityState={state}
						accessibilityValue={accessibilityValue}
						accessible
						className={slots.trigger()}
						{...props}
					>
						{trigger}
					</View>
				) : (
					<Pressable
						accessibilityState={state}
						accessibilityValue={accessibilityValue}
						busy={isLoading}
						className={slots.trigger()}
						disabled={interaction === "blocked" && !isLoading}
						feedback={feedback}
						haptic={haptic}
						onLongPress={onLongPress}
						onPress={handlePress}
						pressedOpacity={pressedOpacity}
						pressedScale={pressedScale}
						{...props}
					>
						{trigger}
					</Pressable>
				)}
				{panelRow}
			</View>
		</StepsItemProvider>
	);
}
StepsItem.displayName = "DelacourUI.Steps.Item";

/**
 * Lifts a `Steps.Indicator` and any `Steps.Panel` out of a step's children, and
 * wraps bare text in a `Steps.Title`.
 *
 * Both places are structural — the indicator between the connector halves, a
 * panel after the trigger — so each is pulled out wherever it was written rather
 * than rendered in the text column.
 * Consecutive strings and numbers collapse into one title, as `Radio` does, so
 * `Step {n}` is one piece of text rather than two spaced apart.
 *
 * Lives here rather than in the root: it is the item that wraps its own
 * children, and a helper in the root file would close a cycle. See AGENTS.md.
 */
function splitChildren(children: ReactNode): {
	indicator: ReactNode | null;
	content: ReactNode[];
	panels: ReactNode[];
} {
	let indicator: ReactNode | null = null;
	const content: ReactNode[] = [];
	const panels: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		content.push(<StepsTitle key={`title-${content.length}`}>{run.join("")}</StepsTitle>);
		run = [];
	};

	for (const child of Children.toArray(children)) {
		if (typeof child === "string" || typeof child === "number") {
			run.push(child);
			continue;
		}
		flushRun();
		if (indicator === null && isValidElement(child) && child.type === StepsIndicator) {
			indicator = child;
			continue;
		}
		if (isValidElement(child) && child.type === StepsPanel) {
			panels.push(child);
			continue;
		}
		content.push(child);
	}
	flushRun();

	return { content, indicator, panels };
}
