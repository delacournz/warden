import type { ReactElement } from "react";
import { View } from "react-native";
import { useEmptyStatePart } from "./empty-state.context";
import type { EmptyStateSlotProps } from "./empty-state.types";
import { emptyStateVariants } from "./empty-state.variants";

/**
 * The centred column holding the media, the title and the description.
 *
 * Its own gap spaces the title from the description; the media adds a margin
 * of its own on top, so the picture sits apart from the two lines of text.
 */
export function EmptyStateHeader({ className, ...props }: EmptyStateSlotProps): ReactElement {
	const { size } = useEmptyStatePart("EmptyState.Header");
	return <View className={emptyStateVariants({ size }).header({ className })} {...props} />;
}
EmptyStateHeader.displayName = "DelacourUI.EmptyState.Header";
