import { type ReactElement, useMemo } from "react";
import { View } from "react-native";
import { IconDefaultsProvider } from "@/components/ui/icon";
import { useListGroupPart } from "./list-group.context";
import type { ListGroupSlotProps } from "./list-group.types";
import { LIST_GROUP_FOREGROUND_TOKEN, listGroupVariants } from "./list-group.variants";

/**
 * The leading slot of a row.
 *
 * Its subtree inherits the list group's icon size and the foreground token, so a
 * bare `<Icon icon={IconWifi} />` comes out right with nothing said at the call
 * site — the same cascade a `Button` gives its icons.
 */
export function ListGroupItemPrefix({ className, children, ...props }: ListGroupSlotProps): ReactElement {
	const { size } = useListGroupPart("ListGroup.ItemPrefix");
	const slots = listGroupVariants({ size });
	const iconClassName = slots.prefixIcon();
	const iconDefaults = useMemo(
		() => ({ className: iconClassName, color: LIST_GROUP_FOREGROUND_TOKEN }),
		[iconClassName]
	);

	return (
		<View className={slots.prefix({ className })} {...props}>
			<IconDefaultsProvider value={iconDefaults}>{children}</IconDefaultsProvider>
		</View>
	);
}
ListGroupItemPrefix.displayName = "DelacourUI.ListGroup.ItemPrefix";
