import type { ReactElement } from "react";
import { View } from "react-native";
import { useCardPart } from "./card.context";
import type { CardSlotProps } from "./card.types";
import { cardVariants } from "./card.variants";

/**
 * A control pinned to the header's top-right corner — a menu button, a badge, a
 * link. `Card.Header` lifts it out of the text column wherever it is written, so
 * the title and description keep the width it leaves.
 */
export function CardAction({ className, ...props }: CardSlotProps): ReactElement {
	const { size } = useCardPart("Card.Action");
	return <View className={cardVariants({ size }).action({ className })} {...props} />;
}
CardAction.displayName = "DelacourUI.Card.Action";
