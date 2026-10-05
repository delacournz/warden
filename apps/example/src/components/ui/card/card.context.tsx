import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { SurfacePlane, SurfaceVariant } from "@/components/ui/surface/surface.variants";
import type { CardSize } from "./card.variants";

export type CardContextValue = {
	/** Size of the card — the padding, the gaps and the title and description scale. */
	size: CardSize;
	/** The fill the card resolved to — explicit, or stepped from the surface it sits in. */
	variant: SurfaceVariant;
	/**
	 * The fill the card's content sits on. The same as `variant` unless that is
	 * `transparent`, which passes the plane beneath it through — `null` on the page.
	 */
	plane: SurfacePlane | null;
};

const CardContext = createContext<CardContextValue | null>(null);

/**
 * Supplies the enclosing card's size and fill to its subtree.
 *
 * Lives in its own module, importing nothing but types, so a part the card
 * renders can read it without importing `./card` and closing a cycle through
 * `card.tsx`. See AGENTS.md rule 3.
 */
export function CardProvider({ value, children }: { value: CardContextValue; children: ReactNode }): ReactElement {
	return <CardContext value={value}>{children}</CardContext>;
}
CardProvider.displayName = "DelacourUI.Card.Provider";

/** The enclosing card's context, or null outside a `<Card>`. */
export function useCardContext(): CardContextValue | null {
	return use(CardContext);
}

/**
 * Reads the enclosing card's size and fill.
 *
 * Lets a custom part match the card — the same inset, a colour that reads on
 * its plane — without the card passing props down. Throws outside a `<Card>`;
 * use {@link useCardContext} where the enclosing card is optional.
 */
export function useCard(): CardContextValue {
	const context = useCardContext();
	if (!context) {
		throw new Error("useCard must be called inside a <Card>.");
	}
	return context;
}

/**
 * The enclosing card's context, for a compound part that cannot work without one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useCard}, whose error message names the hook rather than
 * a part.
 */
export function useCardPart(component: string): CardContextValue {
	const context = useCardContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Card>.`);
	}
	return context;
}
