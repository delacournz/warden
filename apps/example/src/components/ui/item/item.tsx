import { Children, type ReactElement, type ReactNode, useMemo } from "react";
import type { AccessibilityState } from "react-native";
import Animated from "react-native-reanimated";
import { useListGroupContext } from "@/components/ui/list-group/list-group.context";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { type ItemContextValue, ItemProvider } from "./item.context";
import {
	type ItemOrientation,
	type ItemSize,
	type ItemVariant,
	itemVariants,
	resolveItemFeedback,
	resolveItemRender,
	resolveItemSize,
	resolveItemSurface,
} from "./item.variants";
import { ItemActions } from "./item-actions";
import { ItemContent } from "./item-content";
import { ItemDescription } from "./item-description";
import { ItemFooter } from "./item-footer";
import { ItemGroup } from "./item-group";
import { ItemHeader } from "./item-header";
import { ItemMedia } from "./item-media";
import { ItemSeparator } from "./item-separator";
import { ItemTitle } from "./item-title";

export type ItemProps = Omit<PressableProps, "children" | "disabled"> & {
	/**
	 * `default` draws no surface, `outline` a hairline border, `muted` a fill.
	 * Ignored inside a `ListGroup`, which draws the surface itself.
	 */
	variant?: ItemVariant;
	/**
	 * Row density. `Item.Media`, `Item.Title` and `Item.Description` follow it.
	 * Inside a `ListGroup` it defaults to the group's size.
	 */
	size?: ItemSize;
	/** `horizontal` is the list row; `vertical` stacks the parts into a card. */
	orientation?: ItemOrientation;
	isDisabled?: boolean;
	/** Lays the accent fill over the surface and announces the item as selected. */
	isSelected?: boolean;
	children?: ReactNode;
};

function ItemRoot({
	variant = "default",
	size,
	orientation = "horizontal",
	isDisabled = false,
	isSelected = false,
	feedback,
	haptic,
	pressedScale,
	pressedOpacity,
	busy,
	asChild,
	onPress,
	onLongPress,
	accessibilityState,
	className,
	children,
	...props
}: ItemProps): ReactElement {
	const group = useListGroupContext();
	const isInGroup = group !== null;
	const resolvedSize = resolveItemSize(size, group?.size);
	const surface = resolveItemSurface(variant, isInGroup);

	const context = useMemo<ItemContextValue>(
		() => ({ isDisabled, isSelected, orientation, size: resolvedSize, surface }),
		[isDisabled, isSelected, orientation, resolvedSize, surface]
	);
	const content = useMemo(() => wrapTextChildren(children), [children]);
	const rootClassName = itemVariants({ isDisabled, isSelected, orientation, size: resolvedSize, surface }).root({
		className,
	});

	const render = resolveItemRender({ isDisabled, onLongPress, onPress });

	if (render === "pressable") {
		return (
			<ItemProvider value={context}>
				<Pressable
					accessibilityState={{ ...accessibilityState, selected: isSelected }}
					asChild={asChild}
					busy={busy}
					className={rootClassName}
					disabled={isDisabled}
					feedback={resolveItemFeedback(feedback, isInGroup)}
					haptic={haptic}
					onLongPress={onLongPress}
					onPress={onPress}
					pressedOpacity={pressedOpacity}
					pressedScale={pressedScale}
					{...props}
				>
					{content}
				</Pressable>
			</ItemProvider>
		);
	}

	const state: AccessibilityState = { ...accessibilityState, busy, disabled: isDisabled, selected: isSelected };

	return (
		<ItemProvider value={context}>
			<Animated.View accessibilityState={state} className={rootClassName} {...props}>
				{content}
			</Animated.View>
		</ItemProvider>
	);
}

/**
 * Wraps bare text children in a title inside a content column.
 *
 * Consecutive strings and numbers are collected into a single title rather
 * than one each — `Row {index}` is one piece of text. React Native cannot
 * render a string outside a `<Text>`, so without this `<Item>Wi-Fi</Item>`
 * would crash.
 *
 * Lives with the root because the root is what wraps its own text; a part
 * importing it from here would close a cycle. See AGENTS.md rule 3.
 */
function wrapTextChildren(children: ReactNode): ReactNode {
	const items = Children.toArray(children);
	const output: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		output.push(
			<ItemContent key={`content-${output.length}`}>
				<ItemTitle>{run.join("")}</ItemTitle>
			</ItemContent>
		);
		run = [];
	};

	for (const child of items) {
		if (typeof child === "string" || typeof child === "number") {
			run.push(child);
			continue;
		}
		flushRun();
		output.push(child);
	}
	flushRun();

	return output;
}

/**
 * A row of media, text and actions, for lists and settings.
 *
 * Give it an `onPress` and it renders as a `Pressable` announced as a button;
 * leave it off and it is a plain view, so a static row never claims to be a
 * control. `resolveItemRender` makes that call, and a disabled one too. `size` is set once here — the media, the title and the description
 * read it from context.
 *
 * It drops straight into a `ListGroup` as a row: inside one it takes the
 * group's size unless given its own, draws no surface of its own whatever its
 * `variant`, fades rather than scales on press, and pads itself to the inset
 * the group draws its dividers at.
 *
 * @example
 * <Item variant="outline">
 *   <Item.Media variant="icon">
 *     <Icon icon={IconFileText} />
 *   </Item.Media>
 *   <Item.Content>
 *     <Item.Title>Invoice.pdf</Item.Title>
 *     <Item.Description>2.4 MB · Updated yesterday</Item.Description>
 *   </Item.Content>
 *   <Item.Actions>
 *     <Button size="sm" variant="outline">
 *       <Button.Label>Open</Button.Label>
 *     </Button>
 *   </Item.Actions>
 * </Item>
 *
 * @example
 * <ListGroup>
 *   <Item onPress={openWifi}>
 *     <Item.Media>
 *       <Icon icon={IconWifi} />
 *     </Item.Media>
 *     <Item.Content>
 *       <Item.Title>Wi-Fi</Item.Title>
 *     </Item.Content>
 *     <Item.Actions>
 *       <Icon icon={IconChevronRight} />
 *     </Item.Actions>
 *   </Item>
 * </ListGroup>
 */
export const Item = Object.assign(ItemRoot, {
	/** A spaced stack of standalone items, announced as a list. */
	Group: ItemGroup,
	/** A hairline between items in an `Item.Group`. */
	Separator: ItemSeparator,
	/** The leading slot — a bare icon, an icon tile, or an image. Sized by the item. */
	Media: ItemMedia,
	/** The text column, taking the width the media and actions leave. */
	Content: ItemContent,
	/** The primary line. Carries its own colour — a `View` cannot cascade one to a `Text`. */
	Title: ItemTitle,
	/** The secondary line, a step down in scale and on the muted token. */
	Description: ItemDescription,
	/** The trailing slot — buttons, a chevron, a switch, a value. */
	Actions: ItemActions,
	/** A full-width strip above the row's content. */
	Header: ItemHeader,
	/** A full-width strip below the row's content. */
	Footer: ItemFooter,
	displayName: "DelacourUI.Item",
});
