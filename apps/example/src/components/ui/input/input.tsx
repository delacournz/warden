import { type ReactElement, type Ref, useCallback, useState } from "react";
import { TextInput, type TextInputProps } from "react-native";
import { composeRefs } from "@/lib/compose-refs";
import { useButtonGroupItemContext } from "@/components/ui/button/button.context";
import { resolveButtonSizeStep } from "@/components/ui/button/button.variants";
import { useFieldContext } from "@/components/ui/field/field.context";
import { useInputGroupContext } from "./input.context";
import {
	type InputSize,
	type InputVariant,
	resolveInputFieldClass,
	resolvePlaceholderAccentClass,
	resolveSelectionAccentClass,
} from "./input.variants";
import { InputGroup } from "./input-group";

/**
 * The events React Native hands a field's focus and blur callbacks.
 *
 * Read off `TextInputProps` rather than named outright: React Native renamed
 * these between versions, and a restated type would go stale silently — the
 * handler would still compile against the old shape and fail to match the prop.
 */
type InputFocusEvent = Parameters<NonNullable<TextInputProps["onFocus"]>>[0];
type InputBlurEvent = Parameters<NonNullable<TextInputProps["onBlur"]>>[0];

export type InputProps = Omit<TextInputProps, "placeholderTextColorClassName"> & {
	/** Visual variant of the box. Ignored inside an `Input.Group`, which owns the box. */
	variant?: InputVariant;
	/** Size of the box and the value's type scale. Ignored inside an `Input.Group`. */
	size?: InputSize;
	/**
	 * Reports an invalid value. Ignored inside an `Input.Group`, which owns it;
	 * inherited from an enclosing `Field` when neither names it.
	 */
	isInvalid?: boolean;
	/**
	 * Blocks editing and fades the field. Ignored inside an `Input.Group`, which
	 * owns it; inherited from an enclosing `Field` when neither names it.
	 */
	isDisabled?: boolean;
	/**
	 * Placeholder colour, as an `accent-*` utility — `accent-muted-foreground`.
	 * Any other utility resolves to nothing; see `input.variants.ts`.
	 */
	placeholderColorClassName?: string;
	/**
	 * Caret and selection colour, as an `accent-*` utility. Defaults to the
	 * primary token, or the destructive one while the field is invalid.
	 */
	selectionColorClassName?: string;
	ref?: Ref<TextInput>;
};

function InputRoot({
	variant,
	size,
	isInvalid,
	isDisabled,
	className,
	placeholderColorClassName,
	selectionColorClassName,
	editable,
	multiline,
	onBlur,
	onFocus,
	ref,
	...props
}: InputProps): ReactElement {
	const group = useInputGroupContext();
	const field = useFieldContext();
	// A field sitting directly in a `Button.Group` *is* the box, so it draws the
	// run's corner itself. One nested in an `Input.Group` is not: that row owns
	// the box and reads the same context, so the member axes below are simply
	// never consulted — `resolveInputFieldClass` drops the `root` slot entirely
	// when the field is grouped.
	const member = useButtonGroupItemContext();
	const [ownFocused, setOwnFocused] = useState(false);

	// Nearest wins, and there are three sources for the two state axes.
	//
	// Inside a group the box belongs to the group, so the axes that draw one do
	// too — the same way a `ListGroup.Item` takes no `variant`. An enclosing
	// `Field` is the outermost of the three and therefore the last fallback, so
	// a field with no props of its own turns destructive with the `Field` around it
	// while `<Input isInvalid={false} />` still opts out of one.
	const resolved = {
		isDisabled: group?.isDisabled ?? isDisabled ?? field?.isDisabled ?? member?.isDisabled ?? false,
		isInvalid: group?.isInvalid ?? isInvalid ?? field?.isInvalid ?? false,
		size: group?.size ?? (member ? resolveButtonSizeStep(member.size) : size) ?? "md",
		variant: group?.variant ?? variant ?? "primary",
	};

	// The group's box has to light up around a field it does not contain the
	// focus of, so focus is reported upward when there is a group and held here
	// when there is not. Picking the setter is a plain branch, not a hook, so
	// hook order is the same either way.
	const isFocused = group ? group.isFocused : ownFocused;
	const setFocused = group ? group.setFocused : setOwnFocused;

	const handleFocus = useCallback(
		(event: InputFocusEvent) => {
			setFocused(true);
			onFocus?.(event);
		},
		[onFocus, setFocused]
	);

	const handleBlur = useCallback(
		(event: InputBlurEvent) => {
			setFocused(false);
			onBlur?.(event);
		},
		[onBlur, setFocused]
	);

	const selectionAccent = resolveSelectionAccentClass({
		className: selectionColorClassName,
		isInvalid: resolved.isInvalid,
	});

	return (
		<TextInput
			className={resolveInputFieldClass({
				...resolved,
				className,
				groupPosition: member?.position ?? "none",
				isFocused,
				isGrouped: group !== null,
				isMultiline: multiline === true,
				isSeamed: member?.isSeamed ?? false,
				orientation: member?.orientation ?? "horizontal",
			})}
			cursorColorClassName={selectionAccent}
			multiline={multiline}
			placeholderTextColorClassName={resolvePlaceholderAccentClass(placeholderColorClassName)}
			selectionColorClassName={selectionAccent}
			textAlignVertical={multiline ? "top" : undefined}
			{...props}
			editable={resolved.isDisabled ? false : editable}
			onBlur={handleBlur}
			onFocus={handleFocus}
			ref={composeRefs(ref, group?.fieldRef)}
		/>
	);
}

/**
 * A text field.
 *
 * The `TextInput` this renders is uniwind's, not React Native's — uniwind's
 * Metro resolver rewrites the `react-native` import — which is what lets a
 * className drive the three props that take a colour *value* rather than a
 * style: the placeholder, the caret and the selection highlight. No
 * `withUniwind` wrapper is involved, so AGENTS.md rule 7 is untouched. Those
 * classNames must be `accent-*` utilities; see `input.variants.ts` for why.
 *
 * Focus styling is driven from React state rather than a `focus:` class.
 * Uniwind tracks focus per component, so a `focus:` utility would light up a
 * lone field and do nothing for the box `Input.Group` draws around a grouped
 * one — and the decision would sit somewhere `bun test` cannot reach.
 *
 * Everything `TextInput` accepts is accepted here, with one name removed:
 * uniwind's `placeholderTextColorClassName` is replaced by
 * `placeholderColorClassName`, so there is exactly one name for the placeholder
 * colour rather than two that can disagree.
 *
 * Wrap it in an `Input.Group` to put an icon, an affix or a control inside the
 * field's own box.
 *
 * @example
 * <Input onChangeText={setEmail} placeholder="Email" value={email} />
 *
 * @example
 * <Input isInvalid={!isValid} size="lg" variant="secondary" />
 *
 * @example
 * <Input multiline numberOfLines={4} placeholder="Notes" />
 */
export const Input = Object.assign(InputRoot, {
	/** A row that puts prefix and suffix content inside the field's own box. */
	Group: InputGroup,
	displayName: "DelacourUI.Input",
});
