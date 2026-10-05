import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import { useEmptyStatePart } from "./empty-state.context";
import type { EmptyStateTextProps } from "./empty-state.types";
import { emptyStateVariants } from "./empty-state.variants";

/** The supporting line under the title — a step down in scale, on the muted token. */
export function EmptyStateDescription({ className, ...props }: EmptyStateTextProps): ReactElement {
	const { size } = useEmptyStatePart("EmptyState.Description");
	return <Text className={emptyStateVariants({ size }).description({ className })} {...props} />;
}
EmptyStateDescription.displayName = "DelacourUI.EmptyState.Description";
