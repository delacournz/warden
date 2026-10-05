import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { ItemOrientation, ItemSize, ItemSurface } from "./item.variants";

export type ItemContextValue = {
	/** Resolved size — the item's own, else its `ListGroup`'s, else `md`. */
	size: ItemSize;
	/** Whether the item's parts sit side by side or stack. */
	orientation: ItemOrientation;
	/** The surface actually drawn: `grouped` inside a `ListGroup`, else the variant. */
	surface: ItemSurface;
	/** Whether the item is disabled. */
	isDisabled: boolean;
	/** Whether the item is selected. */
	isSelected: boolean;
};

const ItemContext = createContext<ItemContextValue | null>(null);

/**
 * Supplies the enclosing item's resolved size, orientation and surface to its
 * parts.
 *
 * Lives in its own module, importing nothing but `item.variants`, so a part can
 * read it without importing `./item` and closing a cycle through the root. See
 * AGENTS.md rule 3.
 */
export function ItemProvider({ value, children }: { value: ItemContextValue; children: ReactNode }): ReactElement {
	return <ItemContext value={value}>{children}</ItemContext>;
}
ItemProvider.displayName = "DelacourUI.Item.Provider";

/** The enclosing item's context, or null outside an `<Item>`. */
export function useItemContext(): ItemContextValue | null {
	return use(ItemContext);
}

/**
 * Reads the enclosing item's resolved size, orientation and surface.
 *
 * Lets a custom part style itself to match without props passed down through
 * every slot. Throws outside an `<Item>` — use {@link useItemContext} where the
 * enclosing item is optional.
 */
export function useItem(): ItemContextValue {
	const context = useItemContext();
	if (!context) {
		throw new Error("useItem must be called inside an <Item>.");
	}
	return context;
}

/**
 * The enclosing item's context, for a compound part that cannot work without
 * one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useItem}, whose error message names the hook rather than
 * a part.
 */
export function useItemPart(component: string): ItemContextValue {
	const context = useItemContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside an <Item>.`);
	}
	return context;
}
