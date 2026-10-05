import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { BadgeColor, BadgeSize, BadgeVariant } from "./badge.variants";

export type BadgeContextValue = {
	/** Size of the badge. */
	size: BadgeSize;
	/** How the badge's surface is painted. */
	variant: BadgeVariant;
	/** What the badge's surface means. */
	color: BadgeColor;
	/** Whether the badge is disabled. */
	isDisabled: boolean;
};

const BadgeContext = createContext<BadgeContextValue | null>(null);

/**
 * Supplies the enclosing badge's variant, colour, size and state to its subtree.
 *
 * Lives in its own module, importing nothing but `badge.variants`, so a part can
 * read it without importing `./badge`. That import would close a cycle, and
 * Metro serves a partially initialised module for a cycle — leaving the context
 * `undefined` at import time and red-boxing the app on a cold start.
 */
export function BadgeProvider({ value, children }: { value: BadgeContextValue; children: ReactNode }): ReactElement {
	return <BadgeContext value={value}>{children}</BadgeContext>;
}
BadgeProvider.displayName = "DelacourUI.Badge.Provider";

/** The enclosing badge's context, or null outside a `<Badge>`. */
export function useBadgeContext(): BadgeContextValue | null {
	return use(BadgeContext);
}

/**
 * Reads the enclosing badge's variant, colour, size and state.
 *
 * Lets a custom child style itself to match without the badge having to pass
 * props down through every slot. Throws outside a `<Badge>` — use
 * {@link useBadgeContext} where the enclosing badge is optional.
 */
export function useBadge(): BadgeContextValue {
	const context = useBadgeContext();
	if (!context) {
		throw new Error("useBadge must be called inside a <Badge>.");
	}
	return context;
}

/**
 * The enclosing badge's context, for a compound part that cannot work without
 * one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useBadge}, whose error message names the hook rather than
 * a part.
 */
export function useBadgePart(component: string): BadgeContextValue {
	const context = useBadgeContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Badge>.`);
	}
	return context;
}
