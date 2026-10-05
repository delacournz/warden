import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { AvatarColor, AvatarSize, AvatarVariant } from "./avatar.variants";

export type AvatarContextValue = {
	/** The avatar's resolved size — its own, else its group's, else `md`. */
	size: AvatarSize;
	/** How the fallback surface is painted. */
	variant: AvatarVariant;
	/** What the fallback surface means. */
	color: AvatarColor;
	/** Whether the avatar is disabled. */
	isDisabled: boolean;
};

export type AvatarGroupContextValue = {
	/** The size every avatar in the group takes unless it states its own. */
	size?: AvatarSize;
};

const AvatarContext = createContext<AvatarContextValue | null>(null);
const AvatarGroupContext = createContext<AvatarGroupContextValue | null>(null);

/**
 * Supplies the enclosing avatar's size, paint and state to its subtree.
 *
 * Lives in its own module, importing nothing but `avatar.variants`, so a part
 * can read it without importing `./avatar`. That import would close a cycle, and
 * Metro serves a partially initialised module for a cycle — leaving the context
 * `undefined` at import time and red-boxing the app on a cold start.
 */
export function AvatarProvider({ value, children }: { value: AvatarContextValue; children: ReactNode }): ReactElement {
	return <AvatarContext value={value}>{children}</AvatarContext>;
}
AvatarProvider.displayName = "DelacourUI.Avatar.Provider";

/**
 * Supplies a group's size to every avatar inside it.
 *
 * Separate from {@link AvatarProvider} because the two nest the other way round:
 * a group holds avatars, and an avatar must not read a size its group never set
 * as though it had been told one.
 */
export function AvatarGroupProvider({
	value,
	children,
}: {
	value: AvatarGroupContextValue;
	children: ReactNode;
}): ReactElement {
	return <AvatarGroupContext value={value}>{children}</AvatarGroupContext>;
}
AvatarGroupProvider.displayName = "DelacourUI.Avatar.Group.Provider";

/** The enclosing avatar's context, or null outside an `<Avatar>`. */
export function useAvatarContext(): AvatarContextValue | null {
	return use(AvatarContext);
}

/** The enclosing group's context, or null outside an `<Avatar.Group>`. */
export function useAvatarGroupContext(): AvatarGroupContextValue | null {
	return use(AvatarGroupContext);
}

/**
 * Reads the enclosing avatar's size, paint and state.
 *
 * Lets a custom overlay size itself to the face it sits on without the avatar
 * passing props down. Throws outside an `<Avatar>` — use
 * {@link useAvatarContext} where the enclosing avatar is optional.
 */
export function useAvatar(): AvatarContextValue {
	const context = useAvatarContext();
	if (!context) {
		throw new Error("useAvatar must be called inside an <Avatar>.");
	}
	return context;
}

/**
 * The enclosing avatar's context, for a compound part that cannot work without
 * one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useAvatar}, whose error message names the hook rather
 * than a part.
 */
export function useAvatarPart(component: string): AvatarContextValue {
	const context = useAvatarContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside an <Avatar>.`);
	}
	return context;
}
