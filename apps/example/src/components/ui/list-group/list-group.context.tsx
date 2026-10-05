import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { ListGroupSize, ListGroupVariant } from "./list-group.variants";

export type ListGroupContextValue = {
	/** Size of the list group. */
	size: ListGroupSize;
	/** Visual variant of the list group. */
	variant: ListGroupVariant;
};

const ListGroupContext = createContext<ListGroupContextValue | null>(null);

/**
 * Supplies the enclosing list group's size and variant to its subtree.
 *
 * Lives in its own module, importing nothing but `list-group.variants`, so a
 * component the list group renders can read it without importing `../list-group`
 * and closing a cycle through `list-group.tsx`. See AGENTS.md rule 3.
 */
export function ListGroupProvider({
	value,
	children,
}: {
	value: ListGroupContextValue;
	children: ReactNode;
}): ReactElement {
	return <ListGroupContext value={value}>{children}</ListGroupContext>;
}
ListGroupProvider.displayName = "DelacourUI.ListGroup.Provider";

/** The enclosing list group's context, or null outside a `<ListGroup>`. */
export function useListGroupContext(): ListGroupContextValue | null {
	return use(ListGroupContext);
}

/**
 * Reads the enclosing list group's size and variant.
 *
 * Lets a custom row style itself to match without the list group having to pass
 * props down through every slot. Throws outside a `<ListGroup>` — use
 * {@link useListGroupContext} where the enclosing list group is optional.
 */
export function useListGroup(): ListGroupContextValue {
	const context = useListGroupContext();
	if (!context) {
		throw new Error("useListGroup must be called inside a <ListGroup>.");
	}
	return context;
}

/**
 * The enclosing list group's context, for a compound part that cannot work
 * without one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useListGroup}, whose error message names the hook rather
 * than a part.
 */
export function useListGroupPart(component: string): ListGroupContextValue {
	const context = useListGroupContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <ListGroup>.`);
	}
	return context;
}
