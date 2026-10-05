import { type ReactElement, type ReactNode, useCallback, useMemo } from "react";
import { View, type ViewProps } from "react-native";
import { useControllableState } from "@/hooks/use-controllable-state";
import { type CheckboxGroupContextValue, CheckboxGroupProvider } from "./checkbox.context";
import {
	type CheckboxAlignment,
	type CheckboxColor,
	type CheckboxSize,
	checkboxVariants,
	toggleCheckedValue,
} from "./checkbox.variants";

export type CheckboxGroupProps = Omit<ViewProps, "children"> & {
	/** The `value` of every checked child. Controlled. */
	checked?: string[];
	/** The values checked to begin with, while uncontrolled. */
	defaultChecked?: string[];
	/** Fired with the whole list every time a child is toggled. */
	onChecked?: (checked: string[]) => void;
	/** Defaults every child takes unless it names its own. */
	color?: CheckboxColor;
	size?: CheckboxSize;
	alignment?: CheckboxAlignment;
	isInvalid?: boolean;
	isDisabled?: boolean;
	className?: string;
	children?: ReactNode;
};

function CheckboxGroupRoot({
	checked,
	defaultChecked = EMPTY,
	onChecked,
	color,
	size,
	alignment,
	isInvalid,
	isDisabled,
	className,
	children,
	...props
}: CheckboxGroupProps): ReactElement {
	const [values, setValues] = useControllableState<string[]>({
		defaultValue: defaultChecked,
		onChange: onChecked,
		value: checked,
	});

	const toggle = useCallback((value: string) => setValues(toggleCheckedValue(values, value)), [setValues, values]);

	const context = useMemo<CheckboxGroupContextValue>(
		() => ({ alignment, checked: values, color, isDisabled, isInvalid, size, toggle }),
		[alignment, color, isDisabled, isInvalid, size, toggle, values]
	);

	return (
		<CheckboxGroupProvider value={context}>
			<View className={checkboxVariants().group({ className })} {...props}>
				{children}
			</View>
		</CheckboxGroupProvider>
	);
}

/**
 * A stable empty list, so an uncontrolled group does not seed its state from a
 * fresh array on every render.
 */
const EMPTY: string[] = [];

/**
 * The checked list for the checkboxes inside it, and the axes they share.
 *
 * State is one array of the children's `value`s: `checked={["email"]}` ticks the
 * box called `email`, and `onChecked` fires with the whole new list each time
 * one is toggled. Controlled or uncontrolled from the same hook — pass `checked`
 * to own it, or `defaultChecked` and let the group hold it.
 *
 * **The axes here are defaults, not overrides.** A child's own `color` or `size`
 * wins, and so does an explicit `isDisabled={false}` under a disabled group.
 * That is the opposite of `Input.Group`, and the difference is what each owns:
 * `Input.Group` *is* the box its field renders into, so the axes that draw one
 * can only have a single answer. A `Checkbox.Group` owns no box — it is a
 * wrapper supplying context, the same kind of thing as `Field`, and a control
 * overrides one of those.
 *
 * A plain `View`, with no role. A group of checkboxes is a container, and
 * announcing it as a control would put an element with no action in front of
 * every child. Lay them out any other way with a `className` —
 * `flex-row flex-wrap` for a row.
 *
 * @example
 * <Checkbox.Group checked={channels} onChecked={setChannels}>
 *   <Checkbox value="email">Email</Checkbox>
 *   <Checkbox value="sms">SMS</Checkbox>
 *   <Checkbox value="push">Push</Checkbox>
 * </Checkbox.Group>
 *
 * @example
 * <Checkbox.Group color="success" defaultChecked={["daily"]} size="lg">
 *   <Checkbox value="daily">Daily digest</Checkbox>
 *   <Checkbox color="destructive" value="alerts">Incident alerts</Checkbox>
 * </Checkbox.Group>
 */
export const CheckboxGroup = Object.assign(CheckboxGroupRoot, {
	displayName: "DelacourUI.Checkbox.Group",
});
