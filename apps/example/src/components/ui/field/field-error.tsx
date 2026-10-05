import { Children, type ReactElement, type ReactNode } from "react";
import { Text } from "@/components/ui/text";
import { useFieldContext } from "./field.context";
import type { FieldTextProps } from "./field.types";
import { fieldVariants, resolveFieldTextColor } from "./field.variants";

/**
 * `Text` renders `Animated.Text`, so its `children` may also be a Reanimated
 * `SharedValue<ReactNode>`. An error message is a string, and this part has to
 * count its children to know whether to render at all, so the narrower type is
 * both the honest one and the one that can be counted.
 */
export type FieldErrorProps = Omit<FieldTextProps, "children"> & { children?: ReactNode };

/**
 * What is wrong with the value.
 *
 * Renders nothing when it has no children, so
 * `<Field.Error>{errors.email}</Field.Error>` disappears on its own once the
 * value is fixed and needs no conditional at the call site.
 *
 * Deliberately **not** gated on the field's `isInvalid`. A part that swallowed
 * the children a caller actually wrote, because of a prop on a sibling, would be
 * a part whose absence is unexplainable from the call site — and pairing the two
 * is the caller's own `isInvalid={!!error}`, which is one expression, in view.
 *
 * Always destructive, in a valid field as much as an invalid one: an error message is
 * never the calm case.
 */
export function FieldError({ className, color, children, ...props }: FieldErrorProps): ReactElement | null {
	const field = useFieldContext();
	const isInvalid = field?.isInvalid ?? false;
	const isDisabled = field?.isDisabled ?? false;

	if (!hasContent(children)) return null;

	return (
		<Text.Caption
			accessibilityLiveRegion="polite"
			className={fieldVariants({ isDisabled, isInvalid }).error({ className })}
			color={color ?? resolveFieldTextColor("error", isInvalid)}
			role="alert"
			{...props}
		>
			{children}
		</Text.Caption>
	);
}
FieldError.displayName = "DelacourUI.Field.Error";

/**
 * Whether there is anything worth drawing a line of destructive text for.
 *
 * `Children.toArray` drops the `null`, `undefined` and booleans a conditional
 * child leaves behind, so `{error && <Text>{error}</Text>}` counts as empty
 * rather than as one child. An empty string is dropped too — it is what a
 * cleared validation message usually is.
 */
function hasContent(children: ReactNode): boolean {
	return Children.toArray(children).some((child) => child !== "");
}
