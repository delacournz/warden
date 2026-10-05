import { Children, isValidElement, type ReactElement, type ReactNode, useMemo } from "react";
import { View, type ViewProps } from "react-native";
import { Separator } from "@/components/ui/separator";
import { type ListGroupContextValue, ListGroupProvider } from "./list-group.context";
import { type ListGroupSize, type ListGroupVariant, listGroupVariants } from "./list-group.variants";
import { ListGroupItem } from "./list-group-item";
import { ListGroupItemContent } from "./list-group-item-content";
import { ListGroupItemDescription } from "./list-group-item-description";
import { ListGroupItemPrefix } from "./list-group-item-prefix";
import { ListGroupItemSuffix } from "./list-group-item-suffix";
import { ListGroupItemTitle } from "./list-group-item-title";

export type ListGroupProps = ViewProps & {
	variant?: ListGroupVariant;
	size?: ListGroupSize;
	/** Draw a divider between adjacent children. On by default. */
	isDivided?: boolean;
	className?: string;
	children?: ReactNode;
};

function ListGroupRoot({
	variant = "default",
	size = "md",
	isDivided = true,
	className,
	children,
	...props
}: ListGroupProps): ReactElement {
	const context = useMemo<ListGroupContextValue>(() => ({ size, variant }), [size, variant]);

	const slots = listGroupVariants({ size, variant });
	const dividerClassName = slots.divider();

	const content = useMemo(
		() => (isDivided ? withDividers(children, dividerClassName) : children),
		[children, isDivided, dividerClassName]
	);

	return (
		<ListGroupProvider value={context}>
			<View className={slots.root({ className })} {...props}>
				{content}
			</View>
		</ListGroupProvider>
	);
}

/**
 * Inserts a divider between adjacent children.
 *
 * A pair is skipped when either side already is a `Separator`, so a hand-placed
 * divider is never doubled. `Children.toArray` drops the nulls and booleans a
 * conditional child leaves behind, so a row rendered only some of the time does
 * not strand a divider where nothing follows it.
 */
function withDividers(children: ReactNode, dividerClassName: string): ReactNode {
	const items = Children.toArray(children);
	const output: ReactNode[] = [];

	for (const [index, child] of items.entries()) {
		if (index > 0 && !isSeparator(items[index - 1]) && !isSeparator(child)) {
			output.push(<Separator className={dividerClassName} key={`divider-${index}`} />);
		}
		output.push(child);
	}

	return output;
}

function isSeparator(node: ReactNode): boolean {
	return isValidElement(node) && node.type === Separator;
}

/**
 * A surface grouping related rows under one rounded, clipped container.
 *
 * `size` and `variant` reach the sub-components through context, so a row's
 * title picks its own text colour and type scale. That indirection is not
 * incidental: a React Native `View` does not cascade colour to a `Text`
 * descendant the way a DOM element would.
 *
 * Dividers are inserted between adjacent children rather than written out at
 * every call site, inset to line up with the rows' own padding. A `Separator`
 * placed by hand is respected — no divider is added on either side of it — so a
 * caller can still control one gap without turning the whole feature off.
 *
 * @example
 * <ListGroup>
 *   <ListGroup.Item onPress={openProfile}>
 *     <ListGroup.ItemPrefix>
 *       <Icon icon={IconUser} />
 *     </ListGroup.ItemPrefix>
 *     <ListGroup.ItemContent>
 *       <ListGroup.ItemTitle>Personal info</ListGroup.ItemTitle>
 *       <ListGroup.ItemDescription>Name, email, phone</ListGroup.ItemDescription>
 *     </ListGroup.ItemContent>
 *     <ListGroup.ItemSuffix />
 *   </ListGroup.Item>
 * </ListGroup>
 */
export const ListGroup = Object.assign(ListGroupRoot, {
	/** One row of a list group. Bare text children are wrapped in a title inside a content column. */
	Item: ListGroupItem,
	/** The leading slot of a row. Its subtree inherits the group's icon size and foreground token. */
	ItemPrefix: ListGroupItemPrefix,
	/** The text column of a row, taking whatever width the prefix and suffix leave. */
	ItemContent: ListGroupItemContent,
	/** The row's primary line. Carries its own colour — a `View` cannot cascade one to a `Text`. */
	ItemTitle: ListGroupItemTitle,
	/** The row's secondary line, a step down in scale and on the muted token. */
	ItemDescription: ListGroupItemDescription,
	/** The trailing slot of a row, showing a chevron unless given content. */
	ItemSuffix: ListGroupItemSuffix,
	displayName: "DelacourUI.ListGroup",
});
