import { useCallback, useEffect } from "react";
import { AppState, type AppStateStatus, TextInput } from "react-native";
import { KeyboardEvents, useKeyboardContext } from "react-native-keyboard-controller";
import type { SharedValue } from "react-native-reanimated";
import { scheduleOnUI } from "react-native-worklets";
import { shouldResetKeyboardAnimation } from "@/lib/keyboard-animation";

// Re-exported so the pure decision is reachable beside the hook that acts on
// it; it lives in `lib` only because `bun test` cannot follow this module's
// React Native imports.
export { shouldResetKeyboardAnimation } from "@/lib/keyboard-animation";

/** The one pair of animation values `KeyboardProvider` shares with the whole app. */
type KeyboardAnimationValues = {
	progress: SharedValue<number>;
	height: SharedValue<number>;
};

/**
 * Snaps the shared progress and height back to closed when they are stale.
 *
 * The focus check stays on the JS thread — that is where the registry lives —
 * and the read-and-write happens inside one worklet, so the UI thread's own
 * values are what the decision is made against.
 */
export function reconcileKeyboardAnimation({ progress, height }: KeyboardAnimationValues): void {
	if (TextInput.State.currentlyFocusedInput() != null) return;

	scheduleOnUI(() => {
		"worklet";
		if (!shouldResetKeyboardAnimation({ hasFocusedInput: false, height: height.value, progress: progress.value })) {
			return;
		}
		// Snap, never animate: the keyboard is already gone, so there is nothing
		// to animate towards and a timing curve would just be a visible glitch.
		progress.value = 0;
		height.value = 0;
	});
}

/**
 * Repairs the keyboard animation values `KeyboardProvider` shares with the
 * whole app when the keyboard disappears without telling them.
 *
 * `KeyboardProvider` owns exactly ONE pair of Reanimated shared values
 * (`progress` / `height`), and on iOS they are written only by
 * `onKeyboardMoveStart` — emitted from `keyboardWillAppear` /
 * `keyboardWillDisappear` — and by the interactive-move KVO.
 * `onKeyboardMoveEnd`, the event `keyboardDidDisappear` emits, updates them on
 * ANDROID ONLY, and the library has no app-lifecycle re-sync at all.
 *
 * So any teardown that produces no `keyboardWillHide` — an interactive dismiss
 * interrupted by navigation, a native-stack pop, a call interruption, an app
 * suspend — leaves both values pinned at their open state, app-wide, forever.
 * Every consumer then renders "keyboard open" over a screen with no keyboard on
 * it: `Screen.Footer` translates its content up by a keyboard height, and
 * `useScreenScrollInsets` reserves a keyboard-sized spacer under content that
 * needs none.
 *
 * Deliberately NOT used here, and why:
 * - `KeyboardController.dismiss()` resolves on `keyboardDidHide` and natively
 *   just resigns the first responder. With the keyboard already gone there is
 *   no responder, nothing fires, and the values stay stuck — and it would blur
 *   an input the user legitimately has focused.
 * - `setEnabled(false/true)` unmounts and remounts the native observers,
 *   dropping some of them, and never touches the shared values.
 * - Gating each reader behind a screen-local flag adds a second driver to every
 *   consumer and still leaves the globals wrong for the next screen.
 *
 * Mount ONCE, directly inside `<KeyboardProvider>` — or let
 * `DelacourProvider` do it.
 */
export function useKeyboardStateSync(): void {
	const { reanimated } = useKeyboardContext();

	useEffect(() => {
		const appState = AppState.addEventListener("change", (status: AppStateStatus) => {
			if (status === "active") reconcileKeyboardAnimation(reanimated);
		});

		// The `did` events carry the authoritative terminal state, and on iOS the
		// provider throws them away. Mirroring them here is what makes a lost
		// `will` event self-heal on the very next keyboard transition.
		const didHide = KeyboardEvents.addListener("keyboardDidHide", () => {
			scheduleOnUI(() => {
				"worklet";
				reanimated.progress.value = 0;
				reanimated.height.value = 0;
			});
		});
		const didShow = KeyboardEvents.addListener("keyboardDidShow", (event) => {
			// The same height `onKeyboardMoveStart` delivers — both come from the
			// observer's `keyboardHeight`.
			const keyboardHeight = event.height;
			scheduleOnUI(() => {
				"worklet";
				reanimated.progress.value = 1;
				reanimated.height.value = -keyboardHeight;
			});
		});

		// The values may already be stale by the time this mounts.
		reconcileKeyboardAnimation(reanimated);

		return () => {
			appState.remove();
			didHide.remove();
			didShow.remove();
		};
	}, [reanimated]);
}

/**
 * Render-free host for {@link useKeyboardStateSync}, to drop into a layout tree.
 *
 * `DelacourProvider` already mounts this — write it out only when composing the
 * root providers by hand.
 *
 * @example
 * <KeyboardProvider>
 *   <KeyboardStateSync />
 *   <Stack />
 * </KeyboardProvider>
 */
export function KeyboardStateSync(): null {
	useKeyboardStateSync();
	return null;
}
KeyboardStateSync.displayName = "DelacourUI.KeyboardStateSync";

/**
 * Screen-level repair, for a surface that mounts into an already-poisoned
 * global state.
 *
 * Idempotent and cheap — a no-op whenever an input is genuinely focused, which
 * is what keeps "navigate to a new screen with the keyboard still open"
 * working. `Screen.Footer` runs this on mount so a screen repairs itself even
 * in an app that never mounted {@link KeyboardStateSync}.
 */
export function useKeyboardAnimationGuard(): void {
	const { reanimated } = useKeyboardContext();
	const reconcile = useCallback(() => reconcileKeyboardAnimation(reanimated), [reanimated]);

	useEffect(() => {
		reconcile();
	}, [reconcile]);
}
