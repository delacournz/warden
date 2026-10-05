import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import { useFieldContext } from "./field.context";
import type { FieldTextProps } from "./field.types";
import { fieldVariants, resolveFieldTextColor } from "./field.variants";

/**
 * Supporting copy for the control — what the value is for, or what shape it
 * takes.
 *
 * Stays on the muted token whether the field is valid or not, so an appearing
 * `Field.Error` is the one line that changed. It does not fade with a disabled
 * field either: the control already dims itself, and a dimmed explanation on top
 * of a dimmed control reads as two problems rather than one state.
 */
export function FieldDescription({ className, color, ...props }: FieldTextProps): ReactElement {
	const field = useFieldContext();
	const isInvalid = field?.isInvalid ?? false;
	const isDisabled = field?.isDisabled ?? false;

	return (
		<Text.Caption
			className={fieldVariants({ isDisabled, isInvalid }).description({ className })}
			color={color ?? resolveFieldTextColor("description", isInvalid)}
			{...props}
		/>
	);
}
FieldDescription.displayName = "DelacourUI.Field.Description";
