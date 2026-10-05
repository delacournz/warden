import type { ReactElement } from "react";
import { View, type ViewProps } from "react-native";
import { fieldVariants } from "./field.variants";

export type FieldGroupProps = ViewProps & { className?: string };

/**
 * A stack of fields, spaced so that two fields never read as one.
 *
 * Its gap is the loosest step in the ladder — looser than the gap inside a
 * field — which is the whole mechanism by which a label attaches to the control
 * under it rather than to the one above.
 *
 * **Inserts no dividers**, unlike `ListGroup`. A list of rows without lines is a
 * wall of text, but fields are already separated by whitespace and a rule
 * between every one of them is noise. Place a `Field.Separator` where a form
 * genuinely changes subject.
 */
export function FieldGroup({ className, ...props }: FieldGroupProps): ReactElement {
	return <View className={fieldVariants().group({ className })} {...props} />;
}
FieldGroup.displayName = "DelacourUI.Field.Group";
