import type { ReactElement } from "react";
import { View } from "react-native";
import type { ChipSlotProps } from "./chip.types";
import { chipVariants } from "./chip.variants";

/**
 * A centred wrapper for trailing content that is not an `Icon` — a count.
 *
 * An `Icon` needs no wrapper: it inherits the chip's icon size and its
 * surface's colour from the root's `IconDefaultsProvider`.
 */
export function ChipEndContent({ className, ...props }: ChipSlotProps): ReactElement {
	return <View className={chipVariants().endContent({ className })} {...props} />;
}
ChipEndContent.displayName = "DelacourUI.Chip.EndContent";
