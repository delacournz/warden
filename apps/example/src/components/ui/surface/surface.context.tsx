import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { SurfacePlane, SurfaceVariant } from "./surface.variants";

export type SurfaceContextValue = {
	/** The fill the enclosing surface resolved to — explicit, or stepped from its own parent. */
	variant: SurfaceVariant;
	/**
	 * The fill content inside the enclosing surface sits on. The same as
	 * `variant` unless that is `transparent`, which paints nothing and passes the
	 * plane beneath it through — `null` when there is none.
	 */
	plane: SurfacePlane | null;
};

const SurfaceContext = createContext<SurfaceContextValue | null>(null);

/**
 * Supplies the enclosing surface's fill to its subtree.
 *
 * Lives in its own module, importing nothing but `surface.variants`, so a
 * component built on a surface can read it without importing `../surface` and
 * closing a cycle through `surface.tsx`. See AGENTS.md rule 3.
 */
export function SurfaceProvider({
	value,
	children,
}: {
	value: SurfaceContextValue;
	children: ReactNode;
}): ReactElement {
	return <SurfaceContext value={value}>{children}</SurfaceContext>;
}
SurfaceProvider.displayName = "DelacourUI.Surface.Provider";

/** The enclosing surface's context, or null outside a `<Surface>`. */
export function useSurfaceContext(): SurfaceContextValue | null {
	return use(SurfaceContext);
}

/**
 * Reads the enclosing surface's fill.
 *
 * Lets a custom child match the plane it sits on — pick an icon colour from
 * `SURFACE_FOREGROUND_TOKENS[plane]`, or a divider that reads against it —
 * without the surface passing props down. Throws outside a `<Surface>`; use
 * {@link useSurfaceContext} where the enclosing surface is optional.
 */
export function useSurface(): SurfaceContextValue {
	const context = useSurfaceContext();
	if (!context) {
		throw new Error("useSurface must be called inside a <Surface>.");
	}
	return context;
}
