import type { ReactElement } from "react";
import { View } from "react-native";
import type { ItemSlotProps } from "./item.types";
import { itemVariants } from "./item.variants";

/**
 * A full-width strip below the row's content — metadata, a progress bar, a row
 * of buttons. Takes a line of its own on either orientation.
 */
export function ItemFooter({ className, ...props }: ItemSlotProps): ReactElement {
	return <View className={itemVariants().footer({ className })} {...props} />;
}
ItemFooter.displayName = "DelacourUI.Item.Footer";
