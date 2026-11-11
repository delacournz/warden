import { createContext, useContext, useEffect, useId } from "react";

/**
 * What `BottomSheetProvider` shares so a sheet can hide the app behind it.
 *
 * `register` adds one modal sheet and returns its removal. While any is
 * registered the provider hides its children from VoiceOver and TalkBack.
 */
export type BottomSheetModalContextValue = {
	register: (id: string) => () => void;
};

export const BottomSheetModalContext = createContext<BottomSheetModalContextValue | null>(null);
BottomSheetModalContext.displayName = "DelacourUI.BottomSheet.ModalContext";

/**
 * Whether the nearest `BottomSheet.Portal` teleports to the `"root"` host.
 *
 * Only that host draws outside the provider's children. An inline sheet, or
 * one in a `BottomSheet.Host` inside the app (a native modal screen), draws
 * inside them, so hiding the app would hide the sheet too.
 */
export const BottomSheetRootHostContext = createContext(false);
BottomSheetRootHostContext.displayName = "DelacourUI.BottomSheet.RootHostContext";

/** True inside a `BottomSheet.Portal` that teleports to `"root"`. */
export function useIsInRootHost(): boolean {
	return useContext(BottomSheetRootHostContext);
}

/**
 * Hides the app from screen readers while `isModal` is true.
 *
 * A no-op without a `BottomSheetProvider` above.
 */
export function useHideAppWhileModal(isModal: boolean): void {
	const id = useId();
	const register = useContext(BottomSheetModalContext)?.register;

	useEffect(() => {
		if (!isModal || register === undefined) return;
		return register(id);
	}, [isModal, register, id]);
}
