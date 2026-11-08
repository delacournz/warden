import { type ReactElement, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { PortalProvider } from "react-native-teleport";
import {
	OverlayContext,
	type OverlayContextValue,
	TeleportProvidedContext,
	useIsTeleportProvided,
} from "./overlay.context";
import { OverlayPortal } from "./overlay-portal";
import {
	hidesAppContent,
	INITIAL_OVERLAY_REGISTRY,
	type OverlayLayer,
	type OverlayRegistryAction,
	type OverlayRegistryState,
	reduceOverlayRegistry,
} from "./overlay-registry";
import { OverlayScrim } from "./overlay-scrim";
import { isTeleportInline } from "./overlay-teleport";

export type OverlayProviderProps = {
	children?: ReactNode;
};

function OverlayRoot({ children }: OverlayProviderProps): ReactElement {
	const isTeleportProvided = useIsTeleportProvided();
	const current = useRef<OverlayRegistryState>(INITIAL_OVERLAY_REGISTRY);
	const [state, setState] = useState<OverlayRegistryState>(INITIAL_OVERLAY_REGISTRY);

	const present = useCallback((id: string, layer: OverlayLayer, isInApp: boolean) => {
		current.current = reduceOverlayRegistry(current.current, { type: "open", id, layer, isInApp });
		setState(current.current);
	}, []);

	const apply = useCallback((action: OverlayRegistryAction) => {
		const next = reduceOverlayRegistry(current.current, action);
		if (next === current.current) return;
		current.current = next;
		setState(next);
	}, []);
	const exiting = useCallback((id: string, isExiting: boolean) => apply({ type: "exiting", id, isExiting }), [apply]);
	const dismissed = useCallback((id: string) => apply({ type: "close", id }), [apply]);

	const touchListeners = useRef(new Set<() => void>());
	const subscribeTouchStart = useCallback((listener: () => void) => {
		touchListeners.current.add(listener);
		return () => {
			touchListeners.current.delete(listener);
		};
	}, []);
	const onTouchStart = useCallback(() => {
		for (const listener of [...touchListeners.current]) listener();
	}, []);

	const value = useMemo<OverlayContextValue>(
		() => ({ state, present, exiting, dismissed, subscribeTouchStart }),
		[state, present, exiting, dismissed, subscribeTouchStart]
	);

	// `onTouchStart` is a bubbling touch event, not a responder claim: it fires
	// for a touch on any descendant in the React tree — teleported overlays
	// included, since teleport leaves the fiber where it was — and never stops
	// the touch reaching its target or a gesture handler.
	//
	// While a modal overlay is open, the app content is hidden from VoiceOver
	// and TalkBack. The overlays draw in teleport's host, outside this view in
	// the native tree, so they stay reachable. An exiting modal no longer hides
	// it, so focus can return to the trigger in `onExited`. A modal drawn
	// inside this view — `isInline`, or a host other than `"root"` — does not
	// hide it, since that would hide the modal too. Where teleport draws inline
	// — the Jest mock does — every overlay is inside this view, so it stays
	// visible.
	const isAppHidden = hidesAppContent(state) && !isTeleportInline();
	const registry = (
		<OverlayContext.Provider value={value}>
			<View
				accessibilityElementsHidden={isAppHidden}
				importantForAccessibility={isAppHidden ? "no-hide-descendants" : "auto"}
				onTouchStart={onTouchStart}
				style={styles.fill}
			>
				{children}
			</View>
		</OverlayContext.Provider>
	);
	if (isTeleportProvided) return registry;

	return (
		<PortalProvider>
			<TeleportProvidedContext.Provider value>{registry}</TeleportProvidedContext.Provider>
		</PortalProvider>
	);
}

const styles = StyleSheet.create({ fill: { flex: 1 } });

/**
 * The layer every overlay in this library draws into. Mount it once, inside
 * `DelacourProvider` and around the navigator — and around
 * `BottomSheetProvider` when the app has sheets.
 *
 * Two things. Teleport's `PortalProvider`, whose `"root"` host fills the app
 * and is where every dialog, drawer, popover, tooltip, toast and sheet draws —
 * skipped when a provider above already mounted one, because two would mean
 * two native hosts with one name. And the overlay registry, which gives every
 * presented overlay a `zIndex` in its layer's band and tells each one whether it
 * is the top, the one Android's back button closes. While a modal overlay is
 * open, and not animating closed, it hides the app content from screen
 * readers, so focus cannot move behind a dialog. It also hears every touch
 * that starts beneath it, without claiming one, so a tooltip can close on an
 * outside tap that still lands where it was aimed.
 *
 * `DelacourProvider` cannot mount this, for the reason it cannot mount
 * `BottomSheetProvider`: `react-native-teleport` is an optional peer, and an
 * import there would make every app resolve it.
 *
 * `OverlayProvider` is the same component under the name a root layout reads
 * best with; `Overlay.Portal` and `Overlay.Scrim` are the parts every overlay
 * is drawn with.
 *
 * @example
 * <DelacourProvider>
 *   <OverlayProvider>
 *     <BottomSheetProvider>
 *       <Stack />
 *     </BottomSheetProvider>
 *   </OverlayProvider>
 * </DelacourProvider>
 */
export const Overlay = Object.assign(OverlayRoot, {
	/** Teleports its children over the app, in a layer of the z-order. */
	Portal: OverlayPortal,
	/** The dim layer under a modal overlay, faded by presence. */
	Scrim: OverlayScrim,
	displayName: "DelacourUI.Overlay",
});

/** `Overlay` under the name a root layout reads best with. */
export const OverlayProvider = Overlay;
