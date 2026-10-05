import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import type { FieldTextProps } from "./field.types";
import { type FieldLegendVariant, fieldVariants } from "./field.variants";

export type FieldLegendProps = FieldTextProps & {
	/** `legend` titles a set; `label` matches the fields under it. */
	variant?: FieldLegendVariant;
};

/**
 * The title of a `Field.Set`.
 *
 * Two sizes, chosen by picking a `Text` preset rather than by naming a scale:
 * `legend` renders `Text.Paragraph` with a medium weight — a heading for a
 * section of a form — and `label` renders `Text.Label`, which is the treatment
 * the fields below it already use. Reach for `label` when the set is nested
 * inside another, where a second full-size heading would compete with the first.
 *
 * Reads no context: a legend titles a set, and a set holds no state of its own —
 * invalid and disabled belong to each `Field` inside it. That is also why it
 * takes no `isInvalid`; a whole section turning destructive says less than the one
 * field that is wrong.
 */
export function FieldLegend({ className, variant = "legend", ...props }: FieldLegendProps): ReactElement {
	const legendClassName = fieldVariants({ variant }).legend({ className });

	if (variant === "label") {
		return <Text.Label className={legendClassName} {...props} />;
	}

	return <Text.Paragraph className={legendClassName} {...props} />;
}
FieldLegend.displayName = "DelacourUI.Field.Legend";
