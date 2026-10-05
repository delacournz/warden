import { type ReactElement, useMemo } from "react";
import { View } from "react-native";
import { IconDefaultsProvider } from "@/components/ui/icon";
import { useItemPart } from "./item.context";
import type { ItemSlotProps } from "./item.types";
import { ITEM_MEDIA_ICON_TOKEN, type ItemMediaVariant, itemVariants } from "./item.variants";

export type ItemMediaProps = ItemSlotProps & {
	/**
	 * `default` draws nothing and sizes a bare icon to match a `ListGroup` row's.
	 * `icon` sets the glyph on a filled tile. `image` is a fixed square that clips
	 * its child to the corner — give the image `className="size-full"`.
	 */
	variant?: ItemMediaVariant;
};

/**
 * The leading slot — a bare icon, an icon tile, a thumbnail, or an avatar
 * passed straight through.
 *
 * Its subtree inherits an icon size read from the item's size and this slot's
 * variant, and the foreground token, so a bare `<Icon icon={IconFile} />` comes
 * out right with nothing said at the call site.
 */
export function ItemMedia({ variant = "default", className, children, ...props }: ItemMediaProps): ReactElement {
	const { isSelected, size, surface } = useItemPart("Item.Media");
	const slots = itemVariants({ isSelected, mediaVariant: variant, size, surface });
	const iconClassName = slots.mediaIcon();
	const iconDefaults = useMemo(() => ({ className: iconClassName, color: ITEM_MEDIA_ICON_TOKEN }), [iconClassName]);

	return (
		<View className={slots.media({ className })} {...props}>
			<IconDefaultsProvider value={iconDefaults}>{children}</IconDefaultsProvider>
		</View>
	);
}
ItemMedia.displayName = "DelacourUI.Item.Media";
