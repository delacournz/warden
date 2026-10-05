import type { ReactElement } from "react";
import { View } from "react-native";
import type { ItemSlotProps } from "./item.types";
import { itemVariants } from "./item.variants";

/**
 * A full-width strip above the row's content — a cover image, a kicker, a
 * timestamp. Takes a line of its own on either orientation.
 */
export function ItemHeader({ className, ...props }: ItemSlotProps): ReactElement {
	return <View className={itemVariants().header({ className })} {...props} />;
}
ItemHeader.displayName = "DelacourUI.Item.Header";
