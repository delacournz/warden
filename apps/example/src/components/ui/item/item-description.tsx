import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import { useItemPart } from "./item.context";
import type { ItemTextProps } from "./item.types";
import { itemVariants } from "./item.variants";

/** The item's secondary line, a step down in scale and on the muted token. */
export function ItemDescription({ className, ...props }: ItemTextProps): ReactElement {
	const { size } = useItemPart("Item.Description");
	return <Text className={itemVariants({ size }).description({ className })} {...props} />;
}
ItemDescription.displayName = "DelacourUI.Item.Description";
