import type { ReactElement } from "react";
import { View } from "react-native";
import type { ListGroupSlotProps } from "./list-group.types";
import { listGroupVariants } from "./list-group.variants";

/** The text column of a row, taking whatever width the prefix and suffix leave. */
export function ListGroupItemContent({ className, ...props }: ListGroupSlotProps): ReactElement {
	return <View className={listGroupVariants().content({ className })} {...props} />;
}
ListGroupItemContent.displayName = "DelacourUI.ListGroup.ItemContent";
