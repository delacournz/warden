import type { ReactElement } from "react";
import { View } from "react-native";
import { useItemPart } from "./item.context";
import type { ItemSlotProps } from "./item.types";
import { itemVariants } from "./item.variants";

/**
 * The text column. Along a row it takes whatever width the media and actions
 * leave, so the actions stay pinned to the trailing edge.
 */
export function ItemContent({ className, ...props }: ItemSlotProps): ReactElement {
	const { orientation } = useItemPart("Item.Content");
	return <View className={itemVariants({ orientation }).content({ className })} {...props} />;
}
ItemContent.displayName = "DelacourUI.Item.Content";
