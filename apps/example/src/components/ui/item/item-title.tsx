import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import { useItemPart } from "./item.context";
import type { ItemTextProps } from "./item.types";
import { itemVariants } from "./item.variants";

/**
 * The item's primary line.
 *
 * Carries its own colour and type scale, read from the item's context: a React
 * Native `View` does not cascade colour to a `Text` descendant.
 */
export function ItemTitle({ className, ...props }: ItemTextProps): ReactElement {
	const { size } = useItemPart("Item.Title");
	return <Text className={itemVariants({ size }).title({ className })} {...props} />;
}
ItemTitle.displayName = "DelacourUI.Item.Title";
