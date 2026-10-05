import { type ReactElement, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import type { TextInput } from "react-native";
import { useButtonGroupItemContext } from "@/components/ui/button/button.context";
import { resolveButtonSizeStep } from "@/components/ui/button/button.variants";
import { useFieldContext } from "@/components/ui/field/field.context";
import { Pressable } from "@/components/ui/pressable";
import { type InputGroupContextValue, InputGroupProvider } from "./input.context";
import { type InputSize, type InputVariant, resolveInputGroupClass } from "./input.variants";
import { InputGroupPrefix } from "./input-group-prefix";
import { InputGroupSuffix } from "./input-group-suffix";

export type InputGroupProps = {
	/** Visual variant of the box. Read by the `Input` inside it. */
	variant?: InputVariant;
	/** Size of the box, the field's type scale and a decorator's icon. */
	size?: InputSize;
	/**
	 * Reports an invalid value: the border, the caret and the decorators all turn
	 * destructive. Inherited from an enclosing `Field` when it is not given.
	 */
	isInvalid?: boolean;
	/**
	 * Disables the field inside and fades the whole box. Inherited from an
	 * enclosing `Field` when it is not given.
	 */
	isDisabled?: boolean;
	className?: string;
	children?: ReactNode;
};

function InputGroupRoot({
	variant = "primary",
	size = "md",
	isInvalid,
	isDisabled,
	className,
	children,
}: InputGroupProps): ReactElement {
	const fieldRef = useRef<TextInput | null>(null);
	const field = useFieldContext();
	const [isFocused, setFocused] = useState(false);

	// An enclosing `Field` is the outermost source, so it is the last fallback:
	// a group inside an invalid field turns destructive with it, and a group that
	// names its own state overrides that. These are deliberately not defaulted
	// in the destructure — `false` there would swallow the field before it was
	// ever consulted.
	const resolvedIsInvalid = isInvalid ?? field?.isInvalid ?? false;

	// An enclosing `Button.Group` owns the run's shape, so a grouped field draws
	// the group's corner and overlaps its neighbour instead of drawing its own.
	// `size` comes from the group outright — controls of different heights do
	// not join — while `isDisabled` stays a fallback, so one member of a group
	// can still be the only one disabled.
	const member = useButtonGroupItemContext();
	const resolvedSize = member ? resolveButtonSizeStep(member.size) : size;
	const resolvedIsMemberDisabled = isDisabled ?? field?.isDisabled ?? member?.isDisabled ?? false;

	const context = useMemo<InputGroupContextValue>(
		() => ({
			fieldRef,
			isDisabled: resolvedIsMemberDisabled,
			isFocused,
			isInvalid: resolvedIsInvalid,
			setFocused,
			size: resolvedSize,
			variant,
		}),
		[resolvedIsMemberDisabled, isFocused, resolvedIsInvalid, resolvedSize, variant]
	);

	// A lone field is its own tap target edge to edge. Inside a group the field
	// only covers the middle of the box, so the gutter and the space around a
	// decorator have to hand the press on rather than swallow it.
	const focusField = useCallback(() => fieldRef.current?.focus(), []);

	return (
		<InputGroupProvider value={context}>
			<Pressable
				accessible={false}
				className={resolveInputGroupClass({
					className,
					groupPosition: member?.position ?? "none",
					isDisabled: resolvedIsMemberDisabled,
					isFocused,
					isInvalid: resolvedIsInvalid,
					isSeamed: member?.isSeamed ?? false,
					orientation: member?.orientation ?? "horizontal",
					size: resolvedSize,
					variant,
				})}
				disabled={resolvedIsMemberDisabled}
				feedback="none"
				onPress={focusField}
			>
				{children}
			</Pressable>
		</InputGroupProvider>
	);
}

/**
 * A field with content inside its box — a leading icon, a trailing control, a
 * text affix, or all three.
 *
 * The box is the same one a lone `Input` draws. It is not a copy: both read the
 * one `root` slot of `inputVariants`, which lands on the `TextInput` when a
 * field stands alone and on this row when it does not. A grouped field is
 * therefore indistinguishable from an ungrouped one by construction, and
 * `input.variants.test.ts` pins that as a property rather than a comment.
 *
 * The group owns the box, so it owns the axes that draw one — `variant`, `size`,
 * `isInvalid`, `isDisabled` all live here and the `Input` inside reads them from
 * context. One box, one set of axes.
 *
 * Pressing the box focuses the field, so the gutter behaves the way a lone
 * field's does. A control inside a decorator still receives its own press.
 *
 * @example
 * <Input.Group>
 *   <Input.Group.Prefix>
 *     <Icon icon={IconMagnifyingGlass} />
 *   </Input.Group.Prefix>
 *   <Input placeholder="Search" />
 * </Input.Group>
 *
 * @example
 * <Input.Group size="lg">
 *   <Input.Group.Prefix>$</Input.Group.Prefix>
 *   <Input inputMode="decimal" placeholder="0.00" />
 *   <Input.Group.Suffix>NZD</Input.Group.Suffix>
 * </Input.Group>
 */
export const InputGroup = Object.assign(InputGroupRoot, {
	/** Leading content inside the box. An `Icon` or a bare string needs nothing else. */
	Prefix: InputGroupPrefix,
	/** Trailing content inside the box — a clear button, a unit, a reveal toggle. */
	Suffix: InputGroupSuffix,
	displayName: "DelacourUI.Input.Group",
});
