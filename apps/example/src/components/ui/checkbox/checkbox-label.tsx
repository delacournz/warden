import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import { useCheckboxPart } from "./checkbox.context";
import type { CheckboxLabelProps } from "./checkbox.types";
import { checkboxVariants, resolveCheckboxLabelColor, resolveCheckboxLabelSize } from "./checkbox.variants";

/**
 * The checkbox's text, inside the checkbox's own tap target.
 *
 * That is the whole reason this part exists next to `Field.Label`, which does
 * the same job a row away: this one sits inside the pressable, so tapping the
 * words toggles the box. Use `Field.Label` for a checkbox that sits beside its
 * name in a horizontal `Field`, and this one for a checkbox that carries its
 * own.
 *
 * Renders `Text.Label` and passes it a step and a colour, never a class for
 * either — the type scale belongs to the preset, and restating it here would be
 * a second definition of `Text.Label` that could drift from it. The `className`
 * carries layout alone. It turns destructive with the box it names, so the pair reads
 * as one state.
 */
export function CheckboxLabel({ className, color, size, ...props }: CheckboxLabelProps): ReactElement {
	const { alignment, isInvalid, size: checkboxSize } = useCheckboxPart("Checkbox.Label");

	return (
		<Text.Label
			className={checkboxVariants({ alignment }).label({ className })}
			color={color ?? resolveCheckboxLabelColor(isInvalid)}
			size={size ?? resolveCheckboxLabelSize(checkboxSize)}
			{...props}
		/>
	);
}
CheckboxLabel.displayName = "DelacourUI.Checkbox.Label";
