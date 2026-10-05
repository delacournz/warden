import { type ReactElement, useEffect } from "react";
import { Text } from "@/components/ui/text";
import { useFieldContext } from "./field.context";
import type { FieldTextProps } from "./field.types";
import { fieldVariants, resolveFieldLabelText, resolveFieldTextColor } from "./field.variants";

/**
 * The name of the control this field holds.
 *
 * Renders `Text.Label` and passes it a colour, never a size or a weight — the
 * type scale belongs to the preset, and restating it here would be a second
 * definition of `Text.Label` that could drift from it. It turns destructive with the
 * control when the field is invalid, so the pair reads as one state.
 *
 * There is no `htmlFor`. React Native has no `<label>` element and no
 * label-for-control association, which is also why there is no `Field.Title`:
 * on the web that part exists only because a `<div>` is not a `<label>`, and
 * here both would be the same `Text`. **The association is made by hand
 * instead**: a string label hands its text to the field's context, and a control
 * inside with no text of its own — a `Slider.Thumb` — reads it as its accessible
 * name. `resolveFieldLabelText` decides what qualifies.
 */
export function FieldLabel({ className, color, children, ...props }: FieldTextProps): ReactElement {
	const field = useFieldContext();
	const isInvalid = field?.isInvalid ?? false;
	const isDisabled = field?.isDisabled ?? false;

	const registerLabel = field?.registerLabel;
	const labelText = resolveFieldLabelText(children);

	useEffect(() => {
		if (!registerLabel) return;
		registerLabel(labelText);
		return () => registerLabel(null);
	}, [labelText, registerLabel]);

	return (
		<Text.Label
			className={fieldVariants({ isDisabled, isInvalid }).label({ className })}
			color={color ?? resolveFieldTextColor("label", isInvalid)}
			{...props}
		>
			{children}
		</Text.Label>
	);
}
FieldLabel.displayName = "DelacourUI.Field.Label";
