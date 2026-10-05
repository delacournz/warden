import type { ReactElement } from "react";
import { View } from "react-native";
import { useCardPart } from "./card.context";
import type { CardSlotProps } from "./card.types";
import { cardVariants } from "./card.variants";

/** The card's body, inset to line up with the header and footer and spaced by the card's size. */
export function CardContent({ className, ...props }: CardSlotProps): ReactElement {
	const { size } = useCardPart("Card.Content");
	return <View className={cardVariants({ size }).content({ className })} {...props} />;
}
CardContent.displayName = "DelacourUI.Card.Content";
