import { createContext, useContext } from "react";
import type { OverlayLayer, OverlayRegistryState } from "./overlay-registry";

/** What `OverlayProvider` shares with every overlay beneath it. */
export type OverlayContextValue = {
	/** The open set and its z-order. A change re-renders every presented portal. */
	state: OverlayRegistryState;
	/**
	 * A portal reports that its overlay is presented, in which layer, and
	 * whether it draws inside the app content rather than in the `"root"` host.
	 */
	present: (id: string, layer: OverlayLayer, isInApp: boolean) => void;
	/** A portal reports that its overlay started, or stopped, animating closed. */
	exiting: (id: string, isExiting: boolean) => void;
	/** The overlay's portal unmounted. */
	dismissed: (id: string) => void;
	/**
	 * Hear every touch that starts anywhere under the provider — the app, a
	 * sheet, another overlay — without taking it. A non-modal overlay closes on
	 * an outside tap this way and the tap still reaches what was under it.
	 * Returns the unsubscribe.
	 */
	subscribeTouchStart: (listener: () => void) => () => void;
};

export const OverlayContext = createContext<OverlayContextValue | null>(null);
OverlayContext.displayName = "DelacourUI.Overlay.Context";

/** The overlay registry, or `null` outside an `OverlayProvider`. */
export function useOptionalOverlay(): OverlayContextValue | null {
	return useContext(OverlayContext);
}

/**
 * Whether a teleport `PortalProvider` is already mounted above.
 *
 * Teleport registers its hosts natively by name, so two providers would mean
 * two hosts called `"root"`. `OverlayProvider` and this library's
 * `BottomSheetProvider` both set this when they mount one, and both skip
 * their own when it is already set — which is what makes either mount order
 * work.
 *
 * This file is a leaf on purpose: `bottom-sheet/` imports it across folders,
 * and it imports nothing but React and types, so the import can never close a
 * cycle (package rule 3).
 */
export const TeleportProvidedContext = createContext(false);
TeleportProvidedContext.displayName = "DelacourUI.Overlay.TeleportProvided";

/** True beneath a provider that mounted teleport's `PortalProvider`. */
export function useIsTeleportProvided(): boolean {
	return useContext(TeleportProvidedContext);
}
