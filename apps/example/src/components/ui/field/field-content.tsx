import type { ReactElement } from "react";
import { View, type ViewProps } from "react-native";
import { useFieldContext } from "./field.context";
import { fieldVariants } from "./field.variants";

export type FieldContentProps = ViewProps & { className?: string };

/**
 * A label and its description, bundled into one block beside a control.
 *
 * Only needed in a horizontal field, and only when there is a description: it
 * makes the text one flex child so the row lays out as `[text] [control]`
 * instead of `[label] [description] [control]`. `flex-1` is what pushes the
 * control to the far edge; `min-w-0` is what lets the text wrap instead of
 * forcing the row wider than the screen.
 */
export function FieldContent({ className, ...props }: FieldContentProps): ReactElement {
	const field = useFieldContext();
	const isInvalid = field?.isInvalid ?? false;
	const isDisabled = field?.isDisabled ?? false;

	return <View className={fieldVariants({ isDisabled, isInvalid }).content({ className })} {...props} />;
}
FieldContent.displayName = "DelacourUI.Field.Content";
