import { type ReactElement, useMemo } from "react";
import { View } from "react-native";
import { IconDefaultsProvider } from "@/components/ui/icon";
import { useItemPart } from "./item.context";
import type { ItemSlotProps } from "./item.types";
import { ITEM_ACTIONS_ICON_TOKEN, itemVariants } from "./item.variants";

/**
 * The trailing slot — buttons, a chevron, a switch, a value.
 *
 * A bare icon here inherits a step below the media's size and the muted token,
 * so a chevron reads as a hint that the row leads somewhere rather than
 * competing with the row's own subject. A `Button` inside sets its own icon
 * defaults and is unaffected.
 */
export function ItemActions({ className, children, ...props }: ItemSlotProps): ReactElement {
	const { size } = useItemPart("Item.Actions");
	const slots = itemVariants({ size });
	const iconClassName = slots.actionsIcon();
	const iconDefaults = useMemo(() => ({ className: iconClassName, color: ITEM_ACTIONS_ICON_TOKEN }), [iconClassName]);

	return (
		<View className={slots.actions({ className })} {...props}>
			<IconDefaultsProvider value={iconDefaults}>{children}</IconDefaultsProvider>
		</View>
	);
}
ItemActions.displayName = "DelacourUI.Item.Actions";
