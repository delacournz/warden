import type { ReactElement } from "react";
import { Separator, type SeparatorProps } from "@/components/ui/separator";

/**
 * A hairline between items in an `Item.Group`. Match the group's axis — a
 * horizontal group needs `orientation="vertical"`.
 *
 * A `ListGroup` inserts its own dividers, so this is for `Item.Group` only.
 */
export function ItemSeparator(props: SeparatorProps): ReactElement {
	return <Separator {...props} />;
}
ItemSeparator.displayName = "DelacourUI.Item.Separator";
