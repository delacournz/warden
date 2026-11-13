import type { ReactElement } from "react";
import { View } from "react-native";
import { useInputGroupPart, useInputGroupPlacement } from "./input.context";
import { inputVariants } from "./input.variants";

export type InputGroupSeparatorProps = { className?: string };

/**
 * A hairline inside the group's box.
 *
 * Its direction comes from where it is written, not from a prop. Between a
 * decorator and the field, or between two controls in a block, it is a vertical
 * rule across the row. Between a block and the field's row it is a horizontal
 * one, bled out to meet the border on both sides.
 *
 * Hidden from screen readers: it divides, it does not say anything.
 *
 * @example
 * <Input.Group>
 *   <Input.Group.Prefix>$</Input.Group.Prefix>
 *   <Input.Group.Separator />
 *   <Input inputMode="decimal" placeholder="0.00" />
 * </Input.Group>
 */
export function InputGroupSeparator({ className }: InputGroupSeparatorProps): ReactElement {
	const { size } = useInputGroupPart("Input.Group.Separator");
	const placement = useInputGroupPlacement() ?? "row";

	return (
		<View
			accessibilityElementsHidden
			className={inputVariants({ placement, size }).separator({ className })}
			importantForAccessibility="no"
		/>
	);
}
InputGroupSeparator.displayName = "DelacourUI.Input.Group.Separator";
