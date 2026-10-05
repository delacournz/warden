import type { ReactElement } from "react";
import { View } from "react-native";
import { useEmptyStatePart } from "./empty-state.context";
import type { EmptyStateSlotProps } from "./empty-state.types";
import { emptyStateVariants } from "./empty-state.variants";

/**
 * The action slot under the header — usually one or two `Button`s.
 *
 * A centred row that wraps, so two actions sit side by side and fall onto a
 * second line only when they have to. Pass `className="flex-col"` to stack them.
 */
export function EmptyStateContent({ className, ...props }: EmptyStateSlotProps): ReactElement {
	const { size } = useEmptyStatePart("EmptyState.Content");
	return <View className={emptyStateVariants({ size }).content({ className })} {...props} />;
}
EmptyStateContent.displayName = "DelacourUI.EmptyState.Content";
