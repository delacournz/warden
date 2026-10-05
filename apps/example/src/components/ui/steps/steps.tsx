import { Children, isValidElement, type ReactElement, type ReactNode, useCallback, useMemo } from "react";
import { View, type ViewProps } from "react-native";
import { useControllableState } from "@/hooks/use-controllable-state";
import { type StepsContextValue, StepsProvider } from "./steps.context";
import {
	resolveStepsReadOnly,
	STEPS_DEFAULT_ORIENTATION,
	STEPS_DEFAULT_SIZE,
	STEPS_DEFAULT_VARIANT,
	type StepsOrientation,
	type StepsSize,
	type StepsVariant,
	shouldEmitStep,
	stepsVariants,
} from "./steps.variants";
import { StepsDescription } from "./steps-description";
import { StepsIndicator } from "./steps-indicator";
import { StepsItem } from "./steps-item";
import { StepsPanel } from "./steps-panel";
import { StepsTitle } from "./steps-title";

export type StepsProps = ViewProps & {
	/** The current step, zero-based. Controlled. */
	value?: number;
	/** The first current step while uncontrolled. */
	defaultValue?: number;
	/** Called with the pressed step. Never called for a re-press of the current one. */
	onValueChange?: (step: number) => void;
	/** `horizontal` runs the steps across with titles underneath; `vertical` stacks them. */
	orientation?: StepsOrientation;
	size?: StepsSize;
	/** How the indicators are painted. */
	variant?: StepsVariant;
	/** Steps ahead of the value cannot be pressed — the flow's own button is the only way forward. */
	isLinear?: boolean;
	/**
	 * Steps render as plain views and take no presses. Defaults to true for a
	 * controlled `value` with no `onValueChange`, which is a progress display.
	 */
	isReadOnly?: boolean;
	/** Disables every step, overriding a step's own `isDisabled`. */
	isDisabled?: boolean;
	className?: string;
	children?: ReactNode;
};

function StepsRoot({
	value: valueProp,
	defaultValue = 0,
	onValueChange,
	orientation = STEPS_DEFAULT_ORIENTATION,
	size = STEPS_DEFAULT_SIZE,
	variant = STEPS_DEFAULT_VARIANT,
	isLinear = false,
	isReadOnly,
	isDisabled,
	className,
	children,
	...props
}: StepsProps): ReactElement {
	const [value, setValue] = useControllableState<number>({
		value: valueProp,
		defaultValue,
		onChange: onValueChange,
	});

	const select = useCallback(
		(next: number) => {
			if (shouldEmitStep(value, next)) setValue(next);
		},
		[setValue, value]
	);

	// Counted from the direct children, the way `Tabs` walks its panels: the
	// count is what draws a line after every step but the last. A `.map()` is
	// flattened by `Children.toArray` and counts; a step behind a wrapper does not.
	const count = useMemo(
		() => Children.toArray(children).filter((child) => isValidElement(child) && child.type === StepsItem).length,
		[children]
	);

	if (process.env.NODE_ENV !== "production" && count === 0 && Children.count(children) > 0) {
		console.warn(
			"Steps: found no <Steps.Item> among the direct children, so no connectors can be drawn. " +
				"Render the items directly, or from a .map(), rather than behind a wrapper component."
		);
	}

	const resolvedIsReadOnly = resolveStepsReadOnly({
		hasOnValueChange: onValueChange !== undefined,
		isControlled: valueProp !== undefined,
		isReadOnly,
	});

	const context = useMemo<StepsContextValue>(
		() => ({
			count,
			isDisabled,
			isLinear,
			isReadOnly: resolvedIsReadOnly,
			orientation,
			select,
			size,
			value,
			variant,
		}),
		[count, isDisabled, isLinear, resolvedIsReadOnly, orientation, select, size, value, variant]
	);

	return (
		<StepsProvider value={context}>
			<View className={stepsVariants({ orientation, size }).root({ className })} {...props}>
				{children}
			</View>
		</StepsProvider>
	);
}

/**
 * A stepper for a multi-step flow: numbered indicators joined by a line, each
 * step completed, current or upcoming against one zero-based `value`.
 *
 * **The connectors are drawn for you.** The root counts the `Steps.Item`s it
 * holds and every one but the last draws a line to the next, filled once the
 * value has passed it — so there is no separator to place, forget, or leave
 * dangling after the last step.
 *
 * Steps take presses by default and move the value there. A controlled `value`
 * with no `onValueChange` is read-only, a progress display whose steps are not
 * announced as buttons; `isLinear` keeps the steps ahead of the value closed, so
 * only the flow's own button moves it forward.
 *
 * Each step is one accessibility element named by its title, with a value such
 * as "Step 2 of 3, completed".
 *
 * @example
 * <Steps value={step} onValueChange={setStep}>
 *   <Steps.Item step={0}>Account</Steps.Item>
 *   <Steps.Item step={1}>Shipping</Steps.Item>
 *   <Steps.Item step={2}>Payment</Steps.Item>
 * </Steps>
 *
 * @example
 * <Steps orientation="vertical" defaultValue={1}>
 *   <Steps.Item step={0}>
 *     <Steps.Title>Order placed</Steps.Title>
 *     <Steps.Description>We have your order.</Steps.Description>
 *   </Steps.Item>
 *   <Steps.Item step={1} isLoading>
 *     <Steps.Title>Packing</Steps.Title>
 *   </Steps.Item>
 * </Steps>
 */
export const Steps = Object.assign(StepsRoot, {
	/** One step — its indicator, connectors, title and description, as one tap target. */
	Item: StepsItem,
	/** The circle: number, check, cross or spinner. Composed in automatically. */
	Indicator: StepsIndicator,
	/** The step's name, and its accessible name. Bare text in an item becomes one. */
	Title: StepsTitle,
	/** An optional line of supporting text under the title. */
	Description: StepsDescription,
	/** Content below the title but outside the tap target — a form, a summary. */
	Panel: StepsPanel,
	displayName: "DelacourUI.Steps",
});
