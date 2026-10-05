import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import { useListGroupPart } from "./list-group.context";
import type { ListGroupTextProps } from "./list-group.types";
import { listGroupVariants } from "./list-group.variants";

/** The row's secondary line, a step down in scale and on the muted token. */
export function ListGroupItemDescription({ className, ...props }: ListGroupTextProps): ReactElement {
	const { size } = useListGroupPart("ListGroup.ItemDescription");
	return <Text className={listGroupVariants({ size }).description({ className })} {...props} />;
}
ListGroupItemDescription.displayName = "DelacourUI.ListGroup.ItemDescription";
