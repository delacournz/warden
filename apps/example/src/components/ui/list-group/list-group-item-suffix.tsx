import { Children, type ReactElement } from "react";
import { View } from "react-native";
import { IconChevronRight } from "@/lib/icons/central";
import { cn } from "@/lib/cn";
import { Icon, type IconSize } from "@/components/ui/icon";
import { useListGroupPart } from "./list-group.context";
import type { ListGroupSlotProps } from "./list-group.types";
import { LIST_GROUP_SUFFIX_ICON_TOKEN, listGroupVariants } from "./list-group.variants";

export type ListGroupIconProps = {
	/** A named size, or an edge length in points. Beats `className`. */
	size?: IconSize | number;
	/** A theme colour token or a literal. Defaults to `muted-foreground`. */
	color?: string;
	/** A `size-*` utility, beating the group's own suffix size. */
	className?: string;
};

export type ListGroupItemSuffixProps = ListGroupSlotProps & {
	/** Tunes the default chevron. Ignored once the suffix has children of its own. */
	iconProps?: ListGroupIconProps;
};

/**
 * The trailing slot of a row, showing a chevron unless given content.
 *
 * The chevron is a hint that the row leads somewhere, so it sits on the muted
 * token and a step below the leading icon rather than competing with either.
 */
export function ListGroupItemSuffix({
	className,
	iconProps,
	children,
	...props
}: ListGroupItemSuffixProps): ReactElement {
	const { size } = useListGroupPart("ListGroup.ItemSuffix");
	const slots = listGroupVariants({ size });
	const hasContent = Children.toArray(children).length > 0;

	return (
		<View className={slots.suffix({ className })} {...props}>
			{hasContent ? (
				children
			) : (
				<Icon
					className={cn(slots.suffixIcon(), iconProps?.className)}
					color={iconProps?.color ?? LIST_GROUP_SUFFIX_ICON_TOKEN}
					icon={IconChevronRight}
					size={iconProps?.size}
				/>
			)}
		</View>
	);
}
ListGroupItemSuffix.displayName = "DelacourUI.ListGroup.ItemSuffix";
