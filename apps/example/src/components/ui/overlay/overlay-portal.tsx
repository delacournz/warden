import { type ReactElement, type ReactNode, useEffect, useId } from "react";
import { StyleSheet, View } from "react-native";
import { Portal } from "react-native-teleport";
import { useOptionalOverlay } from "./overlay.context";
import { isBelowTopModal, type OverlayLayer, topModalOverlay, zIndexOfOverlay } from "./overlay-registry";

export type OverlayPortalProps = {
	/** Which band of the z-order this overlay draws in. */
	layer: OverlayLayer;
	children?: ReactNode;
	/**
	 * The overlay's registry id. Pass the same id to `useOverlayBackHandler` so
	 * the back button knows whether this overlay is the top. Defaults to a
	 * `useId()` of the portal's own.
	 */
	id?: string;
	/**
	 * The overlay is playing its exit animation — pass
	 * `useOverlayPresence().phase === "exiting"`. An exiting modal stops hiding
	 * the app from screen readers, so `onExited` can move focus back to the
	 * trigger. Default false.
	 */
	isExiting?: boolean;
	/** Render where it is written instead of teleporting. Default false. */
	isInline?: boolean;
	/** The teleport host. Default `"root"` — the one `OverlayProvider`'s teleport provider fills the app with. */
	hostName?: string;
};

let hasWarnedMissingProvider = false;

/**
 * Draws its children over the whole app, in its layer of the z-order.
 *
 * Teleport moves the native view and leaves the React tree where it was, so
 * every context provided around the overlay's trigger — a theme, a form, a
 * query client — still reaches what the portal draws.
 *
 * The overlay is in the registry for exactly as long as this is mounted, so
 * mount it only while the overlay is present (`useOverlayPresence`). Its
 * wrapper is an absolute fill and `box-none`: it takes no touch of its own, so
 * an overlay with no scrim — a toast, a tooltip — leaves the app under it
 * interactive.
 *
 * While a modal overlay is open above it, the frame is hidden from screen
 * readers, so VoiceOver and TalkBack cannot leave the top dialog for one under
 * it. A modal with `isInline` or a custom `hostName` still stacks this way, but
 * does not make `OverlayProvider` hide the app content, which may hold it.
 *
 * Without an `OverlayProvider` above, or with `isInline`, the children render
 * where they are written, in an absolute fill of the nearest positioned
 * ancestor — and the missing provider warns once in development.
 */
export function OverlayPortal({
	layer,
	children,
	id,
	isExiting = false,
	isInline = false,
	hostName = "root",
}: OverlayPortalProps): ReactElement {
	const ownId = useId();
	const overlayId = id ?? ownId;
	const registry = useOptionalOverlay();

	// Only the `"root"` host sits beside the provider's app content. Inline, or
	// in another host, the overlay may be inside that content, so its modal must
	// not hide it.
	const isInApp = isInline || hostName !== "root";
	const present = registry?.present;
	const dismissed = registry?.dismissed;
	useEffect(() => {
		if (present === undefined || dismissed === undefined) return;
		present(overlayId, layer, isInApp);
		return () => dismissed(overlayId);
	}, [present, dismissed, overlayId, layer, isInApp]);

	const exiting = registry?.exiting;
	useEffect(() => {
		exiting?.(overlayId, isExiting);
	}, [exiting, overlayId, isExiting]);

	useEffect(() => {
		if (!__DEV__ || registry !== null || isInline || hasWarnedMissingProvider) return;
		hasWarnedMissingProvider = true;
		console.warn(
			"Overlay.Portal: an overlay rendered with no <OverlayProvider> above it, so it draws inline and may be clipped. Mount OverlayProvider once at the app root."
		);
	}, [registry, isInline]);

	// Screen readers stay inside the top modal. Its frame is modal for
	// VoiceOver, and every frame drawn under it is hidden on both platforms:
	// they share teleport's host, so hiding the app content does not cover them.
	const zIndex = registry === null ? 0 : zIndexOfOverlay(registry.state, overlayId);
	const isTopModal = registry !== null && topModalOverlay(registry.state) === overlayId;
	const isHidden = registry !== null && isBelowTopModal(registry.state, overlayId);
	const frame = (
		<View
			accessibilityElementsHidden={isHidden}
			accessibilityViewIsModal={isTopModal}
			importantForAccessibility={isHidden ? "no-hide-descendants" : "auto"}
			pointerEvents="box-none"
			style={[StyleSheet.absoluteFill, { zIndex }]}
		>
			{children}
		</View>
	);

	if (isInline || registry === null) return frame;

	return (
		<Portal hostName={hostName} style={[StyleSheet.absoluteFill, { zIndex }]}>
			{frame}
		</Portal>
	);
}
OverlayPortal.displayName = "DelacourUI.Overlay.Portal";
