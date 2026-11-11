import {
	BottomSheetHost,
	BottomSheet as Headless,
	type BottomSheetProps as HeadlessBottomSheetProps,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { Presets } from "react-native-pulsar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardAnimationGuard } from "@/hooks/use-keyboard-state-sync";
import { useOptionalOverlay } from "@/components/ui/overlay/overlay.context";
import { topOverlay } from "@/components/ui/overlay/overlay-registry";
import { BottomSheetBackground } from "./bottom-sheet-background";
import { BottomSheetClose } from "./bottom-sheet-close";
import { BottomSheetContainer } from "./bottom-sheet-container";
import { BottomSheetContent } from "./bottom-sheet-content";
import { BottomSheetDescription } from "./bottom-sheet-description";
import { BottomSheetFlatList } from "./bottom-sheet-flat-list";
import { BottomSheetFooter } from "./bottom-sheet-footer";
import { BottomSheetHandle } from "./bottom-sheet-handle";
import { BottomSheetLegendList } from "./bottom-sheet-legend-list";
import { BottomSheetOverlay } from "./bottom-sheet-overlay";
import { BottomSheetPortal } from "./bottom-sheet-portal";
import { BottomSheetProvider } from "./bottom-sheet-provider";
import { BottomSheetScrollView } from "./bottom-sheet-scroll-view";
import { BottomSheetSectionList } from "./bottom-sheet-section-list";
import { BottomSheetStep, BottomSheetSteps } from "./bottom-sheet-steps";
import { BottomSheetTextInput } from "./bottom-sheet-text-input";
import { BottomSheetTitle } from "./bottom-sheet-title";
import { BottomSheetTrigger } from "./bottom-sheet-trigger";

/**
 * Every prop the engine's root takes, with two defaults this skin fills in:
 * `bottomInset` is the device's safe-area bottom unless a caller says
 * otherwise, and the two haptics are the library's own.
 */
export type BottomSheetProps = HeadlessBottomSheetProps;

/**
 * The haptics the sheet plays, as module-scope worklets.
 *
 * Both run on the UI thread from inside the engine's pan, so they are
 * `Presets.System.*` — themselves worklets — and nothing else: a JS function
 * here would be `undefined is not a function` at the moment a finger crosses a
 * snap point. `selection` on a snap point because that is what a picker's tick feels
 * like, and `impactLight` on a close because letting go of a sheet is a
 * heavier event than passing a stop, but not by much.
 */
const snapPointHaptic = Presets.System.selection;
const closeHaptic = Presets.System.impactLight;

/**
 * The engine's root with this library's defaults on it. It renders no view of
 * its own.
 *
 * Four things happen here and nowhere else in the skin:
 *
 * - **`bottomInset` defaults to the safe-area bottom**, read from
 *   `useSafeAreaInsets()`. The engine reserves that band under the body or the
 *   sticky footer and gives it back to the keyboard as it arrives; a caller
 *   never pads for the home indicator by hand.
 * - **The haptics are on by default.** Pass `onSnapPointHaptic={undefined}` to
 *   turn one off, or a worklet of your own to change it.
 * - **The stale-keyboard guard runs on mount.** A sheet mounted while
 *   `KeyboardProvider`'s shared values are pinned open by a keyboard that
 *   vanished without a `will` event would lift for a keyboard that is not
 *   there; `Screen.Footer` runs the same repair for the same reason.
 * - **Android back skips the sheet while an overlay is over it.** Under an
 *   `OverlayProvider`, `closeOnBack` is off while a modal or anchored overlay
 *   is open, so back closes the dialog and leaves the sheet under it.
 *
 * `topInset` is left at the engine's zero, so a `%` snap point is a fraction of the
 * whole window — the same fraction it was before this rewrite.
 */
function BottomSheetRoot({ bottomInset, closeOnBack = true, ...props }: BottomSheetProps): ReactElement {
	const insets = useSafeAreaInsets();
	const overlays = useOptionalOverlay();
	useKeyboardAnimationGuard();

	// Every overlay draws over every sheet, so while one that answers back is
	// open the sheet must not. Sheets and overlays keep separate registries,
	// and `BackHandler` calls the newest listener first: the engine
	// re-subscribes whenever its methods change, so after any parent render
	// the sheet's listener would be newer than the dialog's.
	const isUnderOverlay = overlays !== null && topOverlay(overlays.state) !== null;

	// The haptics go before the spread, not into destructuring defaults: a
	// default also replaces an explicit `undefined`, which is the opt-out.
	return (
		<Headless
			onCloseHaptic={closeHaptic}
			onSnapPointHaptic={snapPointHaptic}
			{...props}
			bottomInset={bottomInset ?? insets.bottom}
			closeOnBack={closeOnBack && !isUnderOverlay}
		/>
	);
}

/**
 * A panel that slides up from the bottom of the screen, over everything.
 *
 * A thin Uniwind skin over `@delacour/react-native-bottom-sheet`: every part
 * here is the engine's part with this library's classes, `Text` presets and
 * `Pressable` on it. The engine owns the state, the geometry, the gestures,
 * the keyboard, the portal and the accessibility; this file owns what it looks
 * like.
 *
 * **The app mounts `BottomSheetProvider` once**, inside `DelacourProvider` and
 * around its navigator. `DelacourProvider` cannot do it — the engine is an
 * optional peer of this library — so the provider is exported from this
 * subpath for the app to place. Without it a `Portal` renders where it is
 * written, which is the inline sheet.
 *
 * Controlled or not, from one hook: pass `isOpen` and `onOpenChange` to own the
 * state, or nothing at all and let the sheet hold it.
 *
 * @example
 * <BottomSheet>
 *   <BottomSheet.Trigger asChild>
 *     <Button variant="secondary">Open</Button>
 *   </BottomSheet.Trigger>
 *   <BottomSheet.Portal>
 *     <BottomSheet.Overlay />
 *     <BottomSheet.Container>
 *       <BottomSheet.Content>
 *         <BottomSheet.Close />
 *         <BottomSheet.Title>Keep yourself safe</BottomSheet.Title>
 *         <BottomSheet.Description>Update to the latest version.</BottomSheet.Description>
 *       </BottomSheet.Content>
 *       <BottomSheet.Footer sticky>
 *         <Button onPress={update}>Update now</Button>
 *       </BottomSheet.Footer>
 *     </BottomSheet.Container>
 *   </BottomSheet.Portal>
 * </BottomSheet>
 *
 * @example
 * // Controlled, snapped, and scrolling.
 * <BottomSheet dynamicSizing={false} isOpen={isOpen} onOpenChange={setOpen} snapPoints={["50%", "90%"]}>
 *   <BottomSheet.Portal>
 *     <BottomSheet.Overlay />
 *     <BottomSheet.Container>
 *       <BottomSheet.ScrollView>{rows}</BottomSheet.ScrollView>
 *     </BottomSheet.Container>
 *   </BottomSheet.Portal>
 * </BottomSheet>
 */
export const BottomSheet = Object.assign(BottomSheetRoot, {
	/** The control that opens the sheet. `asChild` to make a `Button` the trigger. */
	Trigger: BottomSheetTrigger,
	/** Everything drawn above the app, teleported to the nearest host. `inline` to render in place. */
	Portal: BottomSheetPortal,
	/** The scrim. Omit it and the sheet has none. */
	Overlay: BottomSheetOverlay,
	/** The panel that moves. Brings its own `Background` and `Handle` unless you write them. */
	Container: BottomSheetContainer,
	/** The panel's surface — `bg-popover`, top corners rounded, every corner when `detached`. */
	Background: BottomSheetBackground,
	/** The grabber's row, and the sheet's one adjustable accessibility element. */
	Handle: BottomSheetHandle,
	/** The static body. A sheet sized to its content is sized to this. */
	Content: BottomSheetContent,
	/** A scrolling body. Sizes to its rows, capped by `maxDynamicContentSize`, or fills explicit `snapPoints`. */
	ScrollView: BottomSheetScrollView,
	/** A virtualised body. */
	FlatList: BottomSheetFlatList,
	/** A virtualised body with sticky section headers. */
	SectionList: BottomSheetSectionList,
	/** A `LegendList` body. Needs the optional `@legendapp/list` peer. */
	LegendList: BottomSheetLegendList,
	/** Controls at the bottom. `sticky` pins them over the body and rides the keyboard. */
	Footer: BottomSheetFooter,
	/** The dismiss control, positioned out of the content's flow. */
	Close: BottomSheetClose,
	/** The sheet's heading — a `Text.Header` that labels the panel for a screen reader. */
	Title: BottomSheetTitle,
	/** Supporting copy under the title — a muted `Text.Paragraph`. */
	Description: BottomSheetDescription,
	/** An `Input` registered with the sheet, so the keyboard it raises is the sheet's. */
	TextInput: BottomSheetTextInput,
	/** A body whose contents follow a step machine and whose height glides between them. */
	Steps: BottomSheetSteps,
	/** One step of a `Steps` body. */
	Step: BottomSheetStep,
	/** A place for sheets to teleport to other than the root — the recipe for a native modal. */
	Host: BottomSheetHost,
	/** The engine's provider, sharing `OverlayProvider`'s teleport host. Mount it once, inside `DelacourProvider`. */
	Provider: BottomSheetProvider,
	displayName: "DelacourUI.BottomSheet",
});
