/**
 * Whether `KeyboardProvider`'s shared animation values are provably stale.
 *
 * Lives here, free of React Native imports, so the decision is reachable from
 * `bun test` — `hooks/use-keyboard-state-sync` cannot be, since Bun's
 * transpiler cannot parse React Native's Flow-typed source. See AGENTS.md.
 *
 * `hasFocusedInput` MUST come from React Native's own focus registry
 * (`TextInput.State.currentlyFocusedInput()`), never from
 * `KeyboardController.isVisible()`. The latter is fed by the very
 * `keyboardWillShow` / `keyboardDidHide` notifications that go missing in the
 * failure this guard exists for, so in the broken case it reads a stale `true`
 * and would veto the repair. RN's registry is driven by the input's own native
 * focus and blur — a genuinely independent signal.
 */
export function shouldResetKeyboardAnimation(state: {
	/** `KeyboardProvider`'s shared progress, 0 closed through 1 open. */
	progress: number;
	/** `KeyboardProvider`'s shared height, negative while open. */
	height: number;
	/** Whether React Native's focus registry holds a focused `TextInput`. */
	hasFocusedInput: boolean;
}): boolean {
	"worklet";
	// Never fight a real, focused keyboard.
	if (state.hasFocusedInput) return false;
	return state.progress !== 0 || state.height !== 0;
}
