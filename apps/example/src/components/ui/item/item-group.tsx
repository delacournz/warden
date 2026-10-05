import type { ReactElement, ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { type ItemOrientation, itemVariants } from "./item.variants";

export type ItemGroupProps = ViewProps & {
	/**
	 * `vertical` stacks the items down the screen. `horizontal` runs them across,
	 * for a carousel — put it in a horizontal `ScrollView` and give each item
	 * `orientation="vertical"` so every entry reads as a card.
	 */
	orientation?: ItemOrientation;
	className?: string;
	children?: ReactNode;
};

/**
 * A stack of standalone items, spaced rather than divided, announced as a
 * list.
 *
 * For rows sharing one card with dividers between them, put the items in a
 * `ListGroup` instead — they take the group's surface and size from there.
 */
export function ItemGroup({ orientation = "vertical", className, ...props }: ItemGroupProps): ReactElement {
	return (
		<View
			accessibilityRole="list"
			className={itemVariants({ groupOrientation: orientation }).group({ className })}
			{...props}
		/>
	);
}
ItemGroup.displayName = "DelacourUI.Item.Group";
