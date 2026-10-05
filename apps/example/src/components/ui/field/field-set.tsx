import type { ReactElement } from "react";
import { View, type ViewProps } from "react-native";
import { fieldVariants } from "./field.variants";

export type FieldSetProps = ViewProps & { className?: string };

/**
 * A named section of a form — a legend, an optional description, and the fields
 * under them.
 *
 * The step above `Field.Group`: a group is spacing and a set is meaning. Reach
 * for a set when the fields share a heading a reader needs, and for a bare group
 * when they are simply a list.
 *
 * Holds no state. Invalid and disabled belong to each `Field`, because a section
 * that turned destructive as a whole would say less than the one field that is
 * actually wrong.
 */
export function FieldSet({ className, ...props }: FieldSetProps): ReactElement {
	return <View className={fieldVariants().set({ className })} {...props} />;
}
FieldSet.displayName = "DelacourUI.Field.Set";
