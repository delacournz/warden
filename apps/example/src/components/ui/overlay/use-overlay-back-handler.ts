import { useEffect } from "react";
import { BackHandler } from "react-native";
import { useOptionalOverlay } from "./overlay.context";
import { isTopOverlay } from "./overlay-registry";

export type UseOverlayBackHandlerOptions = {
	/** The id the overlay's `Overlay.Portal` was given. */
	id: string;
	/** Listen only while true — typically `isPresent && isDismissible`. */
	isEnabled: boolean;
	onBack: () => void;
};

/**
 * Closes the overlay on Android's back button, but only while it is the top
 * one: a popover over a dialog closes, the dialog under it stays.
 *
 * Without an `OverlayProvider` every overlay is its own top. React Native calls
 * the most recently added listener first, and an overlay drawn over a bottom
 * sheet subscribed after it, so the overlay answers before the sheet does.
 */
export function useOverlayBackHandler({ id, isEnabled, onBack }: UseOverlayBackHandlerOptions): void {
	const registry = useOptionalOverlay();
	const isTop = registry === null ? true : isTopOverlay(registry.state, id);

	useEffect(() => {
		if (!isEnabled || !isTop) return;
		const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
			onBack();
			return true;
		});
		return () => subscription.remove();
	}, [isEnabled, isTop, onBack]);
}
