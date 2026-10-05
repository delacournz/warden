import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { EmptyStateSize, EmptyStateVariant } from "./empty-state.variants";

export type EmptyStateContextValue = {
	/** Size of the empty state. */
	size: EmptyStateSize;
	/** How the empty state sits on the screen. */
	variant: EmptyStateVariant;
};

const EmptyStateContext = createContext<EmptyStateContextValue | null>(null);

/**
 * Supplies the enclosing empty state's size and variant to its subtree.
 *
 * Lives in its own module, importing nothing but `empty-state.variants`, so a
 * part can read it without importing `./empty-state` and closing a cycle
 * through the root. See the package AGENTS.md, rule 3.
 */
export function EmptyStateProvider({
	value,
	children,
}: {
	value: EmptyStateContextValue;
	children: ReactNode;
}): ReactElement {
	return <EmptyStateContext value={value}>{children}</EmptyStateContext>;
}
EmptyStateProvider.displayName = "DelacourUI.EmptyState.Provider";

/** The enclosing empty state's context, or null outside an `<EmptyState>`. */
export function useEmptyStateContext(): EmptyStateContextValue | null {
	return use(EmptyStateContext);
}

/**
 * Reads the enclosing empty state's size and variant.
 *
 * Lets a custom part — an illustration, a link row — scale with the block
 * without the root passing props down. Throws outside an `<EmptyState>`; use
 * {@link useEmptyStateContext} where the enclosing empty state is optional.
 */
export function useEmptyState(): EmptyStateContextValue {
	const context = useEmptyStateContext();
	if (!context) {
		throw new Error("useEmptyState must be called inside an <EmptyState>.");
	}
	return context;
}

/**
 * The enclosing empty state's context, for a compound part that cannot work
 * without one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useEmptyState}, whose error names the hook rather than a
 * part.
 */
export function useEmptyStatePart(component: string): EmptyStateContextValue {
	const context = useEmptyStateContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside an <EmptyState>.`);
	}
	return context;
}
