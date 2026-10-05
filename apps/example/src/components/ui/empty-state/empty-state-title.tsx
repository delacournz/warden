import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import { useEmptyStatePart } from "./empty-state.context";
import type { EmptyStateTextProps } from "./empty-state.types";
import { emptyStateVariants } from "./empty-state.variants";

/**
 * The empty state's heading.
 *
 * Announced as a header, so a screen reader's heading rotor lands on it — the
 * title is what an empty screen *is*. Carries its own colour and type scale
 * from context: a React Native `View` does not cascade colour to a `Text`.
 */
export function EmptyStateTitle({ className, ...props }: EmptyStateTextProps): ReactElement {
	const { size } = useEmptyStatePart("EmptyState.Title");
	return <Text accessibilityRole="header" className={emptyStateVariants({ size }).title({ className })} {...props} />;
}
EmptyStateTitle.displayName = "DelacourUI.EmptyState.Title";
