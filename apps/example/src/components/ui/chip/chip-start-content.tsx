import type { ReactElement } from "react";
import { View } from "react-native";
import type { ChipSlotProps } from "./chip.types";
import { chipVariants } from "./chip.variants";

/**
 * A centred wrapper for leading content that is not an `Icon` — an avatar, a
 * status dot.
 *
 * An `Icon` needs no wrapper: it inherits the chip's icon size and its
 * surface's colour from the root's `IconDefaultsProvider`.
 */
export function ChipStartContent({ className, ...props }: ChipSlotProps): ReactElement {
	return <View className={chipVariants().startContent({ className })} {...props} />;
}
ChipStartContent.displayName = "DelacourUI.Chip.StartContent";
