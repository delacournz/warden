import {
	BottomSheetProvider as HeadlessProvider,
	type BottomSheetProviderProps as HeadlessProviderProps,
} from "@delacour/react-native-bottom-sheet";
import { type ReactElement, useCallback, useMemo, useState } from "react";
import { StyleSheet, View } from "react-native";
import { TeleportProvidedContext, useIsTeleportProvided } from "@/components/ui/overlay/overlay.context";
import { isTeleportInline } from "@/components/ui/overlay/overlay-teleport";
import { BottomSheetModalContext, type BottomSheetModalContextValue } from "./bottom-sheet-modal.context";

export type BottomSheetProviderProps = Omit<HeadlessProviderProps, "hasPortalProvider">;

/**
 * The engine's provider, mounted once by the app — and aware of
 * `OverlayProvider`.
 *
 * Both providers need teleport's `PortalProvider`, and there must be exactly
 * one: teleport registers hosts natively by name, so two would mean two hosts
 * called `"root"`. Whichever of the two mounts outermost mounts it and says so
 * through `TeleportProvidedContext`; the inner one skips its own. Sheets and
 * overlays then share one `"root"` host, ordered by `zIndex` — every overlay's
 * band starts above every sheet's.
 *
 * **It hides the app from screen readers under a modal sheet.** While a sheet
 * with an `Overlay` is presented in the `"root"` host, the children are
 * `accessibilityElementsHidden` and `no-hide-descendants`. The `"root"` host
 * draws beside the children, not inside them, so the sheet stays reachable.
 * `OverlayProvider` does the same for dialogs; the two registries are
 * separate, so each hides for its own.
 *
 * The overlay folder's context file is a leaf (rule 3): it imports nothing but
 * React, so this cross-folder import cannot close a cycle.
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
export function BottomSheetProvider({ children }: BottomSheetProviderProps): ReactElement {
	const isTeleportProvided = useIsTeleportProvided();
	const [modalSheets, setModalSheets] = useState<ReadonlySet<string>>(() => new Set());

	const register = useCallback((id: string) => {
		setModalSheets((current) => new Set(current).add(id));
		return () =>
			setModalSheets((current) => {
				if (!current.has(id)) return current;
				const next = new Set(current);
				next.delete(id);
				return next;
			});
	}, []);
	const modal = useMemo<BottomSheetModalContextValue>(() => ({ register }), [register]);

	// Under a teleport that draws in place (the Jest mock), the sheet is inside
	// the view this hides, so hiding it would hide the sheet too.
	const isAppHidden = modalSheets.size > 0 && !isTeleportInline();

	return (
		<HeadlessProvider hasPortalProvider={isTeleportProvided}>
			<TeleportProvidedContext.Provider value>
				<BottomSheetModalContext.Provider value={modal}>
					<View
						accessibilityElementsHidden={isAppHidden}
						importantForAccessibility={isAppHidden ? "no-hide-descendants" : "auto"}
						style={styles.fill}
					>
						{children}
					</View>
				</BottomSheetModalContext.Provider>
			</TeleportProvidedContext.Provider>
		</HeadlessProvider>
	);
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
BottomSheetProvider.displayName = "DelacourUI.BottomSheet.Provider";
