import { type BottomSheetTextInputHandlers, useBottomSheetTextInput } from "@delacour/react-native-bottom-sheet";

export type BottomSheetInputHandlers = BottomSheetTextInputHandlers;

/**
 * Registers a text field as the sheet's own, so the keyboard it raises is the
 * sheet's to lift for.
 *
 * The engine's `useBottomSheetTextInput()` under the name this library shipped
 * it as. Spread the result onto any `Input` or `TextInput`:
 *
 * ```tsx
 * const sheetInput = useBottomSheetInput();
 * <Input {...sheetInput} placeholder="Name" />
 * ```
 *
 * All three handlers matter: `ref` puts the field's native node in the sheet's
 * registry, `onFocus` claims the keyboard, and `onBlur` gives it up — unless
 * focus moved to another registered field in the same sheet, which is what
 * keeps a tap from one field to the next from reading as a close and a reopen.
 * Outside a sheet the handlers are inert, so a form shared between a screen
 * and a sheet needs no branch.
 *
 * `BottomSheet.TextInput` is this over `Input`, for the plain case.
 */
export const useBottomSheetInput: () => BottomSheetInputHandlers = useBottomSheetTextInput;
