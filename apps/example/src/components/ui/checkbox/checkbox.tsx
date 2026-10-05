import { Children, type ReactElement, type ReactNode, useCallback, useEffect, useMemo, useRef } from "react";
import { useControllableState } from "@/hooks/use-controllable-state";
import { useFieldContext } from "@/components/ui/field/field.context";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { type CheckboxContextValue, CheckboxProvider, useCheckboxGroupContext } from "./checkbox.context";
import type { CheckboxLabelProps } from "./checkbox.types";
import {
	type CheckboxAlignment,
	type CheckboxColor,
	type CheckboxSize,
	checkboxVariants,
	resolveCheckboxAxes,
	resolveCheckboxHitSlop,
} from "./checkbox.variants";
import { CheckboxBox } from "./checkbox-box";
import { CheckboxGroup } from "./checkbox-group";
import { CheckboxLabel } from "./checkbox-label";

export type CheckboxProps = Omit<PressableProps, "asChild" | "busy" | "disabled" | "onPress"> & {
	/**
	 * Identifies this box to an enclosing `Checkbox.Group`. Required inside one,
	 * and ignored outside — a lone checkbox holds its own state.
	 */
	value?: string;
	/** Controlled checked state. Ignored inside a `Checkbox.Group`, which owns it. */
	isChecked?: boolean;
	/** Starting state while uncontrolled. */
	defaultChecked?: boolean;
	onCheckedChange?: (isChecked: boolean) => void;
	/**
	 * Draws a dash rather than a tick and reports `mixed` to a screen reader, for
	 * a parent row over children that are only partly selected.
	 */
	isIndeterminate?: boolean;
	/** What a ticked box means. Inherited from a `Checkbox.Group` when unset. */
	color?: CheckboxColor;
	/** Inherited from a `Checkbox.Group` when unset. */
	size?: CheckboxSize;
	/** `end` pushes the box to the far edge and fills the row with the label. */
	alignment?: CheckboxAlignment;
	/** Reports an invalid value. Inherited from a group, then from a `Field`. */
	isInvalid?: boolean;
	/** Blocks the press and fades the row. Inherited from a group, then a `Field`. */
	isDisabled?: boolean;
	children?: ReactNode;
};

function CheckboxRoot({
	value,
	isChecked,
	defaultChecked = false,
	onCheckedChange,
	isIndeterminate = false,
	color,
	size,
	alignment,
	isInvalid,
	isDisabled,
	feedback = "fade",
	haptic = "selection",
	className,
	children,
	...props
}: CheckboxProps): ReactElement {
	const group = useCheckboxGroupContext();
	const field = useFieldContext();

	const axes = resolveCheckboxAxes({
		field: field ?? undefined,
		group: group ?? undefined,
		own: { alignment, color, isDisabled, isInvalid, size },
	});

	// Called unconditionally so hook order never depends on group membership;
	// which state is *read* below is a plain branch. The same shape `Input` uses
	// to share focus with an `Input.Group`.
	const [ownChecked, setOwnChecked] = useControllableState({
		defaultValue: defaultChecked,
		onChange: onCheckedChange,
		value: isChecked,
	});

	const groupValue = group ? requireValue(value) : undefined;
	const checked = group && groupValue !== undefined ? group.checked.includes(groupValue) : ownChecked;

	const toggle = useCallback(() => {
		if (group && groupValue !== undefined) {
			group.toggle(groupValue);
			return;
		}
		setOwnChecked(!checked);
	}, [checked, group, groupValue, setOwnChecked]);

	// Offered to an enclosing `Field` so tapping the label or the description
	// beside the box ticks it. A checkbox in a form is a small square next to a
	// sentence, and the sentence is what people aim at.
	//
	// Registered through a ref-backed trampoline rather than `toggle` itself:
	// `toggle` is a new function every time `checked` changes, and re-registering
	// on each tick would re-render the whole field for nothing.
	const toggleRef = useRef(toggle);
	toggleRef.current = toggle;
	const registerPress = field?.registerPress;
	const stableToggle = useCallback(() => toggleRef.current(), []);

	useEffect(() => {
		if (!registerPress) return;
		registerPress(stableToggle);
		return () => registerPress(null);
	}, [registerPress, stableToggle]);

	const context = useMemo<CheckboxContextValue>(
		() => ({
			alignment: axes.alignment,
			color: axes.color,
			isChecked: checked,
			isDisabled: axes.isDisabled,
			isIndeterminate,
			isInvalid: axes.isInvalid,
			size: axes.size,
		}),
		[axes.alignment, axes.color, axes.isDisabled, axes.isInvalid, axes.size, checked, isIndeterminate]
	);

	const content = useMemo(() => wrapTextChildren(children), [children]);
	// The box draws itself, including everything the fill state changes, so the
	// root is left with the row and nothing else.
	const rootClassName = checkboxVariants(axes).root({ className });

	return (
		<CheckboxProvider value={context}>
			<Pressable
				accessibilityRole="checkbox"
				accessibilityState={{ checked: isIndeterminate ? "mixed" : checked }}
				className={rootClassName}
				disabled={axes.isDisabled}
				feedback={feedback}
				haptic={haptic}
				hitSlop={resolveCheckboxHitSlop({ hasLabel: Children.count(children) > 0, size: axes.size })}
				onPress={toggle}
				{...props}
			>
				<CheckboxBox />
				{content}
			</Pressable>
		</CheckboxProvider>
	);
}

/**
 * The `value` a grouped checkbox is identified by.
 *
 * A checkbox inside a group with nothing to be called cannot be checked, and the
 * group would silently hold a list that never mentions it. Group membership is
 * not visible in the child's props at compile time, so this cannot be a type
 * error — it throws by name instead, the way `useCheckboxPart` does.
 */
function requireValue(value: string | undefined): string {
	if (value === undefined) {
		throw new Error("A <Checkbox> inside a <Checkbox.Group> needs a `value` for the group to track it by.");
	}
	return value;
}

/**
 * Wraps bare text children in a `Checkbox.Label`.
 *
 * React Native cannot render a string outside a `<Text>`, so
 * `<Checkbox>Remember me</Checkbox>` would otherwise crash. Consecutive strings
 * and numbers are collected into a single label rather than one each — the row's
 * gap would otherwise space the parts of one sentence apart, the same rule and
 * the same reason as `Badge`.
 */
function wrapTextChildren(children: ReactNode): ReactNode {
	const items = Children.toArray(children);
	const output: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		const props: CheckboxLabelProps = { children: run.join("") };
		output.push(<CheckboxLabel key={`label-${output.length}`} {...props} />);
		run = [];
	};

	for (const child of items) {
		if (typeof child === "string" || typeof child === "number") {
			run.push(child);
			continue;
		}
		flushRun();
		output.push(child);
	}
	flushRun();

	return output;
}

/**
 * A box that is ticked or not — on its own, or as one of a group that shares a
 * value list.
 *
 * The root draws the box itself, so `<Checkbox />` is already a complete
 * control. Anything composed inside it lands beside the box and shares its tap
 * target: `<Checkbox.Label>` is the usual thing, and a bare string is wrapped in
 * one automatically.
 *
 * **The whole `Pressable` surface comes through** — `feedback`, `haptic`,
 * `pressedScale`, `onLongPress` and the rest — because the root *is* a
 * `Pressable`. Two defaults differ from a bare one and only two: `fade`, since a
 * spring on a 20pt square reads as a jitter, and a `selection` haptic, since a
 * checkbox is a state toggle and the tick landing is the confirmation. Both are
 * ordinary props, so `haptic={false}` silences it. `onPress` is the one handler
 * that cannot be forwarded — the press *is* the toggle, and `onCheckedChange` is
 * where a side effect goes.
 *
 * State works either way from one hook: pass `isChecked` to control it, or
 * nothing and let it hold its own. Inside a `Checkbox.Group` the group owns it
 * and the box needs a `value` to be tracked by.
 *
 * `isInvalid` and `isDisabled` cascade in from a `Checkbox.Group` and then from
 * a `Field`, so `<Field isInvalid>` reddens the box with nothing said here — and
 * an explicit prop still wins, in either direction.
 *
 * Inside a `Field` the box also hands its toggle back up, so the whole row is
 * the target: tapping a `Field.Label` or the `Field.Description` under it ticks
 * the box. That is what lets a checkbox in a form be a bare `<Checkbox />` with
 * the field naming it, rather than a `Checkbox.Label` repeating the name.
 *
 * @example
 * <Checkbox isChecked={agreed} onCheckedChange={setAgreed}>
 *   <Checkbox.Label>I accept the terms</Checkbox.Label>
 * </Checkbox>
 *
 * @example
 * <Checkbox.Group checked={channels} onChecked={setChannels}>
 *   <Checkbox value="email">Email</Checkbox>
 *   <Checkbox value="sms">SMS</Checkbox>
 * </Checkbox.Group>
 *
 * @example
 * <Checkbox
 *   alignment="end"
 *   color="success"
 *   isIndeterminate={some && !all}
 *   isChecked={all}
 *   onCheckedChange={toggleAll}
 * >
 *   <Checkbox.Label>Select all</Checkbox.Label>
 * </Checkbox>
 */
export const Checkbox = Object.assign(CheckboxRoot, {
	/** The box's text, inside its tap target — tapping the words toggles it. */
	Label: CheckboxLabel,
	/** Owns the checked list for the checkboxes inside it, and their shared axes. */
	Group: CheckboxGroup,
	displayName: "DelacourUI.Checkbox",
});
