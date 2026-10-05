import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import { useListGroupPart } from "./list-group.context";
import type { ListGroupTextProps } from "./list-group.types";
import { listGroupVariants } from "./list-group.variants";

/**
 * The row's primary line.
 *
 * Carries its own colour and type scale, read from the list group's context: a
 * React Native `View` does not cascade colour to a `Text` descendant.
 */
export function ListGroupItemTitle({ className, ...props }: ListGroupTextProps): ReactElement {
	const { size } = useListGroupPart("ListGroup.ItemTitle");
	return <Text className={listGroupVariants({ size }).title({ className })} {...props} />;
}
ListGroupItemTitle.displayName = "DelacourUI.ListGroup.ItemTitle";
