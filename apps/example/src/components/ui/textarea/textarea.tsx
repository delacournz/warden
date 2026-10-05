import { type ReactElement, useCallback, useState } from "react";
import { View } from "react-native";
import { Input, type InputProps } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import {
	resolveTextareaCount,
	resolveTextareaFieldClass,
	resolveTextareaHeightStyle,
	textareaVariants,
} from "./textarea.variants";

/**
 * Whether the field grows with its text.
 *
 * A union so `maxRows` is only accepted where it means something: on a field
 * that does not grow, a ceiling is a number nothing reads.
 */
type TextareaGrowProps =
	| {
			/** Stay `rows` tall and scroll past it. The default. */
			autoGrow?: false;
			maxRows?: never;
	  }
	| {
			/** Grow with the text, from `rows` up to `maxRows`, then scroll. */
			autoGrow: true;
			/** The tallest the field grows, in lines. Default 10. */
			maxRows?: number;
	  };

/**
 * Whether a character count sits under the field.
 *
 * A union so the count cannot be asked for without a limit: a count with
 * nothing to count towards says nothing, and a runtime check would only find
 * that out on a device.
 */
type TextareaCountProps =
	| {
			showCount?: false;
			/** The most characters the field accepts. */
			maxLength?: number;
	  }
	| {
			/** Show how much of `maxLength` is used, under the field's trailing edge. */
			showCount: true;
			maxLength: number;
	  };

export type TextareaProps = Omit<InputProps, "multiline" | "numberOfLines" | "maxLength"> &
	TextareaGrowProps &
	TextareaCountProps & {
		/** How many lines tall the field is — its height when fixed, its floor when growing. Default 4. */
		rows?: number;
		/** Class for the view holding the field and its count. `className` styles the field itself. */
		containerClassName?: string;
	};

/**
 * A multiline text field, sized in rows.
 *
 * The box is `Input`'s — its variants, sizes, focus ring, invalid border,
 * disabled fade and the `Field` cascade all come from there unchanged, so a
 * textarea and the single-line fields above it in a form are the same control
 * at a different height rather than two that happen to match.
 *
 * What this adds is the height. `rows` is a line count, and it becomes points
 * through the paragraph leading and the box's own padding and border — see
 * `resolveTextareaHeightStyle`. It is applied as a style, never a class,
 * because a runtime number cannot be a Tailwind class. `size` changes the type
 * and leading, so a small three-row field and a large one are both three rows.
 *
 * `autoGrow` floors the field at `rows` and caps it at `maxRows`; between the
 * two, React Native's multiline `TextInput` sizes itself to its content, and
 * past the cap it scrolls. `showCount` with `maxLength` puts a count under the
 * trailing edge that turns destructive at the limit.
 *
 * `multiline` and `numberOfLines` are withheld: it is always multiline, and its
 * height comes from `rows`.
 *
 * Label, description and error come from `Field`, exactly as they do for
 * `Input` — there is no `label` prop.
 *
 * @example
 * <Field>
 *   <Field.Label>Notes</Field.Label>
 *   <Textarea placeholder="Anything we should know?" />
 * </Field>
 *
 * @example
 * <Textarea autoGrow maxRows={8} rows={2} placeholder="Message" />
 *
 * @example
 * <Textarea maxLength={280} onChangeText={setStatus} showCount value={status} />
 */
export function Textarea({
	rows,
	autoGrow,
	maxRows,
	showCount,
	maxLength,
	size,
	className,
	containerClassName,
	style,
	value,
	defaultValue,
	onChangeText,
	...props
}: TextareaProps): ReactElement {
	const resolvedSize = size ?? "md";
	const slots = textareaVariants({ size: resolvedSize });

	// The count reads the value's length whether or not the caller owns the
	// value. Controlled, `value` is the truth; uncontrolled, the last text the
	// field reported is — seeded from `defaultValue` so the count is right on
	// the first frame rather than after the first keystroke.
	const [ownLength, setOwnLength] = useState(() => defaultValue?.length ?? 0);
	const length = value === undefined ? ownLength : value.length;

	const handleChangeText = useCallback(
		(text: string) => {
			setOwnLength(text.length);
			onChangeText?.(text);
		},
		[onChangeText]
	);

	const count = showCount && maxLength !== undefined ? resolveTextareaCount({ length, maxLength }) : null;

	return (
		<View className={slots.root({ className: containerClassName })}>
			<Input
				{...props}
				className={resolveTextareaFieldClass({ className, size: resolvedSize })}
				defaultValue={defaultValue}
				maxLength={maxLength}
				multiline
				onChangeText={handleChangeText}
				size={resolvedSize}
				style={[resolveTextareaHeightStyle({ autoGrow, maxRows, rows, size: resolvedSize }), style]}
				value={value}
			/>
			{count ? (
				<Text.Caption
					accessibilityLabel={count.accessibilityLabel}
					accessibilityLiveRegion="polite"
					className={slots.count()}
					color={count.color}
				>
					{count.label}
				</Text.Caption>
			) : null}
		</View>
	);
}
Textarea.displayName = "DelacourUI.Textarea";
