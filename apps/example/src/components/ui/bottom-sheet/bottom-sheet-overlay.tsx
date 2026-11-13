import {
	BottomSheet as Headless,
	type BottomSheetOverlayProps as HeadlessProps,
	useBottomSheetInternal,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { withUniwind } from "uniwind";
import {
	BOTTOM_SHEET_BACKDROP_INDICES,
	BOTTOM_SHEET_OVERLAY_OPACITY,
	bottomSheetVariants,
} from "./bottom-sheet.variants";
import { useHideAppWhileModal, useIsInRootHost } from "./bottom-sheet-modal.context";

type StyledOverlayComponent = (props: HeadlessProps & { className?: string }) => ReactElement | null;

// Third-party to Uniwind, so `className` needs the wrapper, built once at
// module scope.
const StyledOverlay = withUniwind(Headless.Overlay) as unknown as StyledOverlayComponent;

export type BottomSheetOverlayProps = HeadlessProps & {
	className?: string;
};

/**
 * The scrim over the app behind the sheet.
 *
 * `bg-overlay`, a token that carries its own alpha, so the `opacity` here is 1
 * and the two theme variants can differ. The engine fades it with the sheet's
 * index — never with the keyboard — and makes it a plain `Pressable` written
 * before the panel, which is what lets a tap on a field inside the sheet reach
 * the field.
 *
 * Omit it and the sheet has no scrim at all. `pressBehavior="none"` keeps it
 * and makes it inert, for a sheet that must be answered.
 *
 * **A scrim makes the sheet modal for screen readers.** While the sheet is
 * presented in the `"root"` host, the overlay tells `BottomSheetProvider` to
 * hide the app from VoiceOver and TalkBack. The panel's
 * `accessibilityViewIsModal` hides only its siblings in the host, not the app.
 * An inline sheet, a sheet in another host, and `enableTouchThrough` leave the
 * app reachable.
 *
 * @example
 * <BottomSheet.Overlay />
 *
 * @example
 * <BottomSheet.Overlay pressBehavior="none" />
 */
export function BottomSheetOverlay({
	appearsOnIndex = BOTTOM_SHEET_BACKDROP_INDICES.appearsOnIndex,
	className,
	disappearsOnIndex = BOTTOM_SHEET_BACKDROP_INDICES.disappearsOnIndex,
	enableTouchThrough = false,
	opacity = BOTTOM_SHEET_OVERLAY_OPACITY,
	...props
}: BottomSheetOverlayProps): ReactElement {
	const { presented } = useBottomSheetInternal();
	const isInRootHost = useIsInRootHost();
	useHideAppWhileModal(presented && isInRootHost && !enableTouchThrough);

	return (
		<StyledOverlay
			appearsOnIndex={appearsOnIndex}
			className={bottomSheetVariants().overlay({ className })}
			disappearsOnIndex={disappearsOnIndex}
			enableTouchThrough={enableTouchThrough}
			opacity={opacity}
			{...props}
		/>
	);
}
BottomSheetOverlay.displayName = "DelacourUI.BottomSheet.Overlay";
