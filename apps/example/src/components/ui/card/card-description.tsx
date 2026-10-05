import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import { useCardPart } from "./card.context";
import type { CardTextProps } from "./card.types";
import { cardVariants } from "./card.variants";

/** The muted supporting line under the title, a step down the type scale from it. */
export function CardDescription({ className, ...props }: CardTextProps): ReactElement {
	const { size } = useCardPart("Card.Description");
	return <Text className={cardVariants({ size }).description({ className })} {...props} />;
}
CardDescription.displayName = "DelacourUI.Card.Description";
