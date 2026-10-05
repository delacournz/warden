import { type ReactElement, useCallback, useMemo, useState } from "react";
import { View, type ViewProps } from "react-native";
import { Pressable } from "@/components/ui/pressable";
import { type FieldContextValue, FieldProvider } from "./field.context";
import { type FieldOrientation, fieldVariants, resolveFieldInteractive } from "./field.variants";
import { FieldContent } from "./field-content";
import { FieldDescription } from "./field-description";
import { FieldError } from "./field-error";
import { FieldGroup } from "./field-group";
import { FieldLabel } from "./field-label";
import { FieldLegend } from "./field-legend";
import { FieldSeparator } from "./field-separator";
import { FieldSet } from "./field-set";

export type FieldProps = ViewProps & {
	/** `vertical` stacks label over control; `horizontal` puts them side by side. */
	orientation?: FieldOrientation;
	/** Reports an invalid value. The label and the control inside both turn destructive. */
	isInvalid?: boolean;
	/** The control inside is unavailable. Fades the label and disables the control. */
	isDisabled?: boolean;
	className?: string;
};

function FieldRoot({
	orientation = "vertical",
	isInvalid = false,
	isDisabled = false,
	className,
	...props
}: FieldProps): ReactElement {
	// State rather than a ref, because the answer changes what the row renders
	// as. A control registers in an effect, so this costs one extra render on
	// mount and none afterwards — the registered callback is stable.
	const [controlPress, setControlPress] = useState<(() => void) | null>(null);

	// The updater form would call `press` instead of storing it.
	const registerPress = useCallback((press: (() => void) | null) => setControlPress(() => press), []);

	// The label's text, for a control inside to read as its accessible name.
	// State for the same reason as the press: a control renders differently for
	// it, and the label registers in an effect, so it costs one render on mount.
	const [label, setLabel] = useState<string | null>(null);
	const registerLabel = useCallback((next: string | null) => setLabel(next), []);

	const context = useMemo<FieldContextValue>(
		() => ({ isDisabled, isInvalid, label, orientation, registerLabel, registerPress }),
		[isDisabled, isInvalid, label, orientation, registerLabel, registerPress]
	);

	const rootClassName = fieldVariants({ isDisabled, isInvalid, orientation }).root({ className });

	// A field is layout until a control asks for the row — see `resolveFieldInteractive`.
	if (!resolveFieldInteractive(controlPress)) {
		return (
			<FieldProvider value={context}>
				<View accessibilityRole="none" className={rootClassName} {...props} />
			</FieldProvider>
		);
	}

	return (
		<FieldProvider value={context}>
			<Pressable
				// The control inside is the accessibility element, not this row.
				// Without it a screen reader would announce the label twice and
				// offer a wrapper with no state of its own.
				accessible={false}
				className={rootClassName}
				disabled={isDisabled}
				feedback="none"
				onPress={controlPress}
				{...props}
			/>
		</FieldProvider>
	);
}

/**
 * One control, with its label, its description and its error.
 *
 * The layout every form in this library repeats, done once — and the one place a
 * field's state is written down. `<Field isInvalid>` turns the label destructive
 * **and the control inside it too**, with nothing said at the control: `Input`
 * and `Checkbox` both read this field's context, and `Radio` will read the same one.
 *
 * That cascade is a React context rather than a class because it has to be.
 * Uniwind's data selectors match against the props of the component carrying the
 * class, so there is no parent-scoped `group-data-*` for a `Field` to style its
 * control with. See `field.context.tsx`.
 *
 * A control's own prop still wins, so one field inside an invalid group can opt
 * out with `<Input isInvalid={false} />`.
 *
 * **The label names the control, too.** `Field.Label` hands its text down the
 * same context, so a control with no text of its own — a `Slider.Thumb`, a
 * `Switch` — reads "Volume" to a screen reader rather than a bare number. React
 * Native has no `<label for>`; this is that association. Only a plain string or
 * number label is lent, since a label built from elements has no text to read
 * before it renders.
 *
 * **The whole row drives the control**, once one offers a press through the same
 * context — so tapping "Accept the terms", or the description under it, ticks
 * the `Checkbox` beside it. A checkbox in a form is a small square next to a
 * sentence, and the sentence is the part people aim at. The row is a `Pressable`
 * with `feedback="none"` only while a control has registered; a field of static
 * text mounts no gesture detector at all.
 *
 * The text parts render the `Text` presets and pass a colour, never a size —
 * `Field.Label` *is* `Text.Label`. There is no `Field.Title`: on the web it
 * exists because a `<div>` is not a `<label>`, and React Native has neither.
 *
 * @example
 * <Field>
 *   <Field.Label>Full name</Field.Label>
 *   <Input placeholder="Ada Lovelace" />
 *   <Field.Description>This appears on invoices.</Field.Description>
 * </Field>
 *
 * @example
 * <Field isInvalid={!isValid}>
 *   <Field.Label>Email</Field.Label>
 *   <Input inputMode="email" onChangeText={setEmail} value={email} />
 *   <Field.Error>{error}</Field.Error>
 * </Field>
 *
 * @example
 * <Field.Set>
 *   <Field.Legend>Profile</Field.Legend>
 *   <Field.Description>Shown on invoices and emails.</Field.Description>
 *   <Field.Group>
 *     <Field>
 *       <Field.Label>Username</Field.Label>
 *       <Input autoCapitalize="none" />
 *     </Field>
 *   </Field.Group>
 * </Field.Set>
 */
export const Field = Object.assign(FieldRoot, {
	/** A named section of a form — a legend, a description, and the fields under them. */
	Set: FieldSet,
	/** The title of a `Field.Set`. `variant="label"` for a nested one. */
	Legend: FieldLegend,
	/** A stack of fields, spaced so two never read as one. Inserts no dividers. */
	Group: FieldGroup,
	/** The control's name. Turns destructive with the control when the field is invalid. */
	Label: FieldLabel,
	/** Supporting copy. Stays muted in every state, so an error is the line that changed. */
	Description: FieldDescription,
	/** What is wrong with the value. Renders nothing when it has no children. */
	Error: FieldError,
	/** A label and its description as one block, for a horizontal field. */
	Content: FieldContent,
	/** A rule between sections, optionally labelled between two rules. */
	Separator: FieldSeparator,
	displayName: "DelacourUI.Field",
});
