import { useBottomSheetTextInput } from "@delacour/react-native-bottom-sheet";
import { type ReactElement, useCallback, useMemo } from "react";
import type { BlurEvent, FocusEvent, TextInputInstance } from "react-native";
import { composeRefs } from "@/lib/compose-refs";
import { Input, type InputProps } from "@/components/ui/input";

export type BottomSheetTextInputProps = InputProps;

/**
 * An `Input` registered with the sheet.
 *
 * The library's `Input` — variant, size, `Input.Group` and all — with the
 * engine's `useBottomSheetTextInput()` spread onto it, so the keyboard it
 * raises is the sheet's to lift for under any `keyboardScope`, including
 * `registered`. A caller's own `ref`, `onFocus` and `onBlur` still run.
 *
 * A field of your own takes `useBottomSheetInput()` instead and keeps its
 * component; this is the plain case.
 *
 * @example
 * <BottomSheet.TextInput placeholder="Name" value={name} onChangeText={setName} />
 */
export function BottomSheetTextInput({ ref, onFocus, onBlur, ...props }: BottomSheetTextInputProps): ReactElement {
	const handlers = useBottomSheetTextInput();
	const composed = useMemo(() => composeRefs<TextInputInstance | null>(ref, handlers.ref), [ref, handlers.ref]);

	const handleFocus = useCallback(
		(event: FocusEvent) => {
			handlers.onFocus();
			onFocus?.(event);
		},
		[handlers.onFocus, onFocus]
	);
	const handleBlur = useCallback(
		(event: BlurEvent) => {
			handlers.onBlur();
			onBlur?.(event);
		},
		[handlers.onBlur, onBlur]
	);

	return <Input onBlur={handleBlur} onFocus={handleFocus} ref={composed} {...props} />;
}
BottomSheetTextInput.displayName = "DelacourUI.BottomSheet.TextInput";
