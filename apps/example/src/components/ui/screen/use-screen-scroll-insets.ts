import { useState } from "react";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import {
	type DerivedValue,
	type SharedValue,
	useAnimatedReaction,
	useAnimatedScrollHandler,
	useAnimatedStyle,
	useDerivedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { useScreenPart } from "./screen.context";
import {
	CHAT_COMPOSER_GAP,
	footerAboveKeyboard,
	footerOccupancy,
	resolveScrollBottomInset,
	resolveScrollTopInset,
	type ScreenScrollInsetMode,
} from "./screen.variants";

/**
 * The footer's collapsed baseline height, as JS state.
 *
 * The measurement arrives on the UI thread, so it is mirrored across rather
 * than read directly — a `.value` captured in a memo or effect closure becomes
 * a memo-cache dependency read during render once React Compiler is on, which
 * Reanimated's strict mode rejects.
 *
 * A measured 0 means NOT MEASURED YET — mount, or the footer unmounting — and
 * is ignored, so a caller's seed survives until a real height replaces it.
 */
function useFooterBaselineHeight(estimatedHeight = 0): number {
	const { footer } = useScreenPart("a Screen scrollable");
	const [measured, setMeasured] = useState(() => Math.round(estimatedHeight));

	useAnimatedReaction(
		() => Math.round(footer.initialHeight.value),
		(current, previous) => {
			if (current <= 0 || current === previous) return;
			scheduleOnRN(setMeasured, current);
		},
		[]
	);

	return measured;
}

/**
 * The shared value a footer's own content drives when it expands VISUALLY above
 * its measured layout box.
 *
 * For a composer pill that grows upward without changing the height it
 * occupies. Drive it as a discrete reservation — the full expanded height while
 * open, 0 when closed — and set it BEFORE focusing the input, so a chat
 * scrollable sees the right padding on the same frame it starts lifting. Do NOT
 * interpolate it with keyboard progress: a mid-animation write races the lift
 * and can overwrite it with a stale offset.
 *
 * Growth while the keyboard is already open is fine — those deltas are small.
 * Reset it to 0 on unmount; `Screen.Footer` clears the measured heights but
 * never this one, because it does not own it.
 */
export function useScreenFooterOverlayHeight(): SharedValue<number> {
	const { footer } = useScreenPart("useScreenFooterOverlayHeight");
	return footer.overlayHeight;
}

/**
 * Live composer clearance as a UI-thread value: the footer's full occupancy,
 * plus whatever overlays above it, plus the breathing gap.
 *
 * Feed this to a chat list's own inset props so composer growth and keyboard
 * motion land in the SAME frame. Routing it through React state instead lags
 * the keyboard by a re-render, which reads as jank.
 */
export function useChatComposerInset(): DerivedValue<number> {
	const { footer } = useScreenPart("useChatComposerInset");
	const { bottom } = useSafeAreaInsets();

	return useDerivedValue(
		() => footerOccupancy(footer.height.value, bottom) + footer.overlayHeight.value + CHAT_COMPOSER_GAP,
		[bottom]
	);
}

/**
 * The composer's growth above its collapsed baseline, as a UI-thread value.
 *
 * A growing input extends the scroll range through this rather than through a
 * re-render, so the list never re-lays-out mid-keystroke.
 */
export function useChatComposerGrowthPadding(): DerivedValue<number> {
	const { footer } = useScreenPart("useChatComposerGrowthPadding");

	return useDerivedValue(
		() => Math.max(0, footer.height.value - footer.initialHeight.value) + footer.overlayHeight.value,
		[]
	);
}

export type { ScreenScrollInsetMode };

/** A chat list's static bottom clearance, split so each band is separately visible under `<Screen debug>`. */
export type ChatComposerSpacer = {
	/** Exactly what the footer covers — the band whose edge must land on the footer's own. */
	occupancy: number;
	/** Breathing room between the newest message and the composer, above `occupancy`. */
	gap: number;
	/** `occupancy + gap` — the whole reserve. */
	total: number;
};

/**
 * The STATIC layout spacer a chat list reserves for the composer. Live growth
 * and keyboard motion go through the UI-thread values above, never here.
 *
 * The safe-area band IS included: it is correct in both keyboard states, and
 * the derivation is in `screen.variants`. Omitting it leaves every chat list
 * short by exactly the inset.
 *
 * `estimatedFooterHeight` SEEDS the first render and is read once — later
 * changes are ignored. Pass it whenever the composer's collapsed height is a
 * known constant. The footer only publishes its real height a commit or two
 * AFTER the list's first layout, and a virtualised list cannot always correct
 * for that afterwards: once the footer has grown it reads the shifted offset as
 * "the user scrolled away" and abandons its retarget. That is why the newest
 * message hides under the composer only SOMETIMES. A correct first paint is the
 * only reliable fix.
 */
export function useChatComposerBaseSpacerHeight(estimatedFooterHeight = 0): ChatComposerSpacer {
	const { bottom } = useSafeAreaInsets();
	const measured = useFooterBaselineHeight(estimatedFooterHeight);
	const occupancy = footerOccupancy(measured, bottom);

	return { gap: CHAT_COMPOSER_GAP, occupancy, total: occupancy + CHAT_COMPOSER_GAP };
}

/**
 * Clearance a keyboard-aware scrollable needs between its focused input and the
 * keyboard's top edge.
 *
 * A sticky footer rides the keyboard, so the input has to clear the footer too,
 * not just the keyboard. Deliberately NOT the full occupancy: the sticky shift
 * parks the footer's safe-area band behind the keyboard, so counting it here
 * would scroll the input further than it needs to go.
 */
export function useScreenFooterKeyboardClearance(): number {
	return footerAboveKeyboard(useFooterBaselineHeight()) + CHAT_COMPOSER_GAP;
}

/**
 * The shared scroll reporting and top/bottom spacer styles every Screen
 * scrollable is built on.
 *
 * One hook rather than a copy per list, so `Screen.ScrollArea`,
 * `Screen.FlatList`, `Screen.SectionList` and the rest cannot drift on what
 * "clear the navbar" means.
 *
 * Both insets are spacer HEIGHTS rather than content padding. A padded content
 * container cannot animate on the UI thread, and the navbar's height is only
 * known after it lays out — so a spacer view whose height is an animated style
 * is what lets the reserve appear in the same frame as the measurement.
 */
export function useScreenScrollInsets(mode: ScreenScrollInsetMode) {
	const { navbar, footer, scrollY, contentHeight, layoutHeight } = useScreenPart("a Screen scrollable");
	const { bottom, top } = useSafeAreaInsets();
	const keyboard = useReanimatedKeyboardAnimation();

	const scrollHandler = useAnimatedScrollHandler({
		onScroll: (event) => {
			scrollY.value = event.contentOffset.y;

			if (event.contentSize.height !== contentHeight.value) {
				contentHeight.value = event.contentSize.height;
			}

			if (event.layoutMeasurement.height !== layoutHeight.value) {
				layoutHeight.value = event.layoutMeasurement.height;
			}
		},
	});

	const insetTopAnimatedStyle = useAnimatedStyle(() => {
		return {
			height: resolveScrollTopInset({
				navbarHeight: navbar.height.value,
				navbarPlacement: navbar.placement.value,
				safeAreaTop: top,
			}),
		};
	}, [top]);

	const insetBottomAnimatedStyle = useAnimatedStyle(() => {
		return {
			height: resolveScrollBottomInset({
				footerHeight: footer.height.value,
				footerPlacement: footer.placement.value,
				keyboardHeight: keyboard.height.value,
				keyboardProgress: keyboard.progress.value,
				mode,
				safeAreaBottom: bottom,
			}),
		};
	}, [mode, bottom]);

	return { insetBottomAnimatedStyle, insetTopAnimatedStyle, scrollHandler };
}

/**
 * The scroll handler and spacer styles a Screen scrollable is built from.
 *
 * Inferred rather than written out: `useAnimatedStyle`'s return type carries
 * Reanimated's own internal branding, and restating it here by hand would be a
 * second definition that can drift from the one Reanimated actually returns.
 */
export type ScreenScrollInsets = ReturnType<typeof useScreenScrollInsets>;
