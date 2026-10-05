import type { ReactElement } from "react";
import { Text } from "@/components/ui/text";
import { useCardPart } from "./card.context";
import type { CardTextProps } from "./card.types";
import { cardVariants } from "./card.variants";

/**
 * The card's heading.
 *
 * Carries its own colour — the foreground token of the plane the card resolved
 * to — and its own step on the type scale, read from the card's context: a
 * React Native `View` does not cascade colour to a `Text` descendant. Announced
 * as a header, so a screen reader's rotor stops on each card in a list.
 */
export function CardTitle({ className, ...props }: CardTextProps): ReactElement {
	const { size, plane } = useCardPart("Card.Title");
	return (
		<Text
			accessibilityRole="header"
			className={cardVariants({ plane: plane ?? "none", size }).title({ className })}
			{...props}
		/>
	);
}
CardTitle.displayName = "DelacourUI.Card.Title";
