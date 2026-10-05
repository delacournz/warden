import type { ReactElement } from "react";
import { View } from "react-native";
import { useCardPart } from "./card.context";
import type { CardSlotProps } from "./card.types";
import { type CardFooterVariant, cardVariants, resolveCardFooterFill } from "./card.variants";

export type CardFooterProps = CardSlotProps & {
	/**
	 * `default` is a row of actions under the content. `band` sets it into the
	 * card as a strip of its own — a rule across the top, the next fill down, and
	 * the card's bottom corners — for a footer that is what someone does with the
	 * card rather than more of what it says.
	 */
	variant?: CardFooterVariant;
};

/**
 * The card's last row — its actions, or a status line.
 *
 * A `band` footer steps its fill from the card's own plane rather than naming a
 * colour, so it stays a step apart from the card however deep it is nested.
 * It should be the card's last child: it pulls itself down over the card's
 * bottom padding to meet the edge.
 */
export function CardFooter({ variant = "default", className, ...props }: CardFooterProps): ReactElement {
	const { size, plane } = useCardPart("Card.Footer");
	const slots = cardVariants({ footer: variant, footerFill: resolveCardFooterFill(plane), size });
	return <View className={slots.footer({ className })} {...props} />;
}
CardFooter.displayName = "DelacourUI.Card.Footer";
