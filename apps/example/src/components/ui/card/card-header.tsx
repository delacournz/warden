import { isValidElement, type ReactElement, type ReactNode } from "react";
import { View } from "react-native";
import { useCardPart } from "./card.context";
import type { CardSlotProps } from "./card.types";
import { cardVariants, splitCardHeaderChildren } from "./card.variants";
import { CardAction } from "./card-action";
import { CardTitle } from "./card-title";

function isCardAction(node: ReactNode): boolean {
	return isValidElement(node) && node.type === CardAction;
}

/**
 * Wraps a bare string or number in a `Card.Title`. A raw string inside a `View`
 * is a red box in React Native, and a header's bare text is its title.
 */
function wrapBareText(node: ReactNode, index: number): ReactNode {
	return typeof node === "string" || typeof node === "number" ? (
		<CardTitle key={`title-${index}`}>{node}</CardTitle>
	) : (
		node
	);
}

/**
 * The card's opening block: a title and description stacked on the left, and
 * any `Card.Action` pinned to the top right.
 *
 * The header lifts every action out of the column wherever it is written, so
 * the order of children does not matter and the text wraps in the width the
 * action leaves. Bare text becomes a title.
 */
export function CardHeader({ className, children, ...props }: CardSlotProps): ReactElement {
	const { size } = useCardPart("Card.Header");
	const slots = cardVariants({ size });
	const { text, actions } = splitCardHeaderChildren(children, isCardAction);

	return (
		<View className={slots.header({ className })} {...props}>
			<View className={slots.headerText()}>{text.map(wrapBareText)}</View>
			{actions}
		</View>
	);
}
CardHeader.displayName = "DelacourUI.Card.Header";
