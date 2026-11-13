import {
	Children,
	isValidElement,
	type ReactElement,
	type ReactNode,
	useCallback,
	useMemo,
	useRef,
	useState,
} from "react";
import { type TextInputInstance, View } from "react-native";
import { useButtonGroupItemContext } from "@/components/ui/button/button.context";
import { resolveButtonSizeStep } from "@/components/ui/button/button.variants";
import { useFieldContext } from "@/components/ui/field/field.context";
import { Pressable } from "@/components/ui/pressable";
import {
	type InputGroupContextValue,
	InputGroupOuterBlockProvider,
	InputGroupPlacementProvider,
	InputGroupProvider,
} from "./input.context";
import {
	type InputGroupChildKind,
	type InputGroupSegment,
	type InputSize,
	type InputVariant,
	resolveGroupSegments,
	resolveInputGroupClass,
	resolveInputGroupRowClass,
	resolveOuterBlocks,
} from "./input.variants";
import { InputGroupBlock, type InputGroupBlockProps } from "./input-group-block";
import { InputGroupButton } from "./input-group-button";
import { InputGroupPrefix } from "./input-group-prefix";
import { InputGroupSeparator } from "./input-group-separator";
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
	const fieldRef = useRef<TextInputInstance | null>(null);
	const field = useFieldContext();
	const [isFocused, setFocused] = useState(false);
	const [isMultiline, setMultiline] = useState(false);

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
			setMultiline,
			size: resolvedSize,
			variant,
		}),
		[resolvedIsMemberDisabled, isFocused, resolvedIsInvalid, resolvedSize, variant]
	);

	// A lone field is its own tap target edge to edge. Inside a group the field
	// only covers the middle of the box, so the gutter and the space around a
	// decorator have to hand the press on rather than swallow it.
	const focusField = useCallback(() => fieldRef.current?.focus(), []);

	const sections = useMemo(() => sortIntoSections(children), [children]);
	const hasBlocks = sections.start.length > 0 || sections.end.length > 0;

	const box = {
		groupPosition: member?.position ?? "none",
		hasBlocks,
		isDisabled: resolvedIsMemberDisabled,
		isFocused,
		isInvalid: resolvedIsInvalid,
		isMultiline,
		isSeamed: member?.isSeamed ?? false,
		orientation: member?.orientation ?? "horizontal",
		size: resolvedSize,
		variant,
	} as const;

	// The row is rendered whether or not a block is, so adding one moves
	// nothing that was already there — the field is never remounted, and never
	// loses focus, when a toolbar appears above it.
	return (
		<InputGroupProvider value={context}>
			<Pressable
				accessible={false}
				className={resolveInputGroupClass({ ...box, className })}
				disabled={resolvedIsMemberDisabled}
				feedback="none"
				onPress={focusField}
			>
				<InputGroupPlacementProvider value="box">{sections.start}</InputGroupPlacementProvider>
				<View className={resolveInputGroupRowClass(box)}>
					<InputGroupPlacementProvider value="row">{sections.row}</InputGroupPlacementProvider>
				</View>
				<InputGroupPlacementProvider value="box">{sections.end}</InputGroupPlacementProvider>
			</Pressable>
		</InputGroupProvider>
	);
}

/**
 * Sorts a group's direct children into the box's three sections — above the
 * row, in it, and below it. `resolveGroupSegments` holds the rule; this only
 * names what each child is. The outermost block of each section is marked, so
 * only it cancels the box's padding (`resolveOuterBlocks`).
 */
function sortIntoSections(children: ReactNode): Record<InputGroupSegment, ReactNode[]> {
	const items = Children.toArray(children);
	const kinds = items.map(classifyGroupChild);
	const segments = resolveGroupSegments(kinds);
	const outer = resolveOuterBlocks(kinds);
	const sections: Record<InputGroupSegment, ReactNode[]> = { end: [], row: [], start: [] };

	for (const [index, child] of items.entries()) {
		const placed =
			outer[index] && isValidElement(child) ? (
				<InputGroupOuterBlockProvider key={child.key} value>
					{child}
				</InputGroupOuterBlockProvider>
			) : (
				child
			);
		sections[segments[index] ?? "row"].push(placed);
	}

	return sections;
}

function classifyGroupChild(child: ReactNode): InputGroupChildKind {
	if (!isValidElement(child)) return "content";
	if (child.type === InputGroupBlock) {
		return (child.props as InputGroupBlockProps).position === "start" ? "block-start" : "block-end";
	}
	if (child.type === InputGroupSeparator) return "separator";
	return "content";
}

/**
 * A field with content inside its box — a leading icon, a trailing control, a
 * text affix, or all three.
 *
 * The box is the same one a lone `Input` draws. It is not a copy: both read the
 * one `root` slot of `inputVariants`, which lands on the `TextInput` when a
 * field stands alone and on this row when it does not. A grouped field is
 * therefore indistinguishable from an ungrouped one by construction, as a property rather than a comment.
 *
 * The group owns the box, so it owns the axes that draw one — `variant`, `size`,
 * `isInvalid`, `isDisabled` all live here and the `Input` inside reads them from
 * context. One box, one set of axes.
 *
 * Pressing the box focuses the field, so the gutter behaves the way a lone
 * field's does. A control inside a decorator still receives its own press.
 *
 * A `Block` adds a full-width section above or below the field inside the same
 * box, and a `Textarea` takes the field's place for a multiline composer. A
 * `Separator` draws a hairline, vertical in the row and horizontal between
 * sections.
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
 *
 * @example
 * <Input.Group>
 *   <Textarea rows={3} placeholder="Message" />
 *   <Input.Group.Block position="end">
 *     <Input.Group.Button variant="secondary" onPress={send}>Send</Input.Group.Button>
 *   </Input.Group.Block>
 * </Input.Group>
 */
export const InputGroup = Object.assign(InputGroupRoot, {
	/** Leading content inside the box. An `Icon` or a bare string needs nothing else. */
	Prefix: InputGroupPrefix,
	/** Trailing content inside the box — a clear button, a unit, a reveal toggle. */
	Suffix: InputGroupSuffix,
	/** A `Button` sized from the group and disabled with it. */
	Button: InputGroupButton,
	/** A hairline — vertical in the row, horizontal between a block and the row. */
	Separator: InputGroupSeparator,
	/** A full-width section above (`start`) or below (`end`) the field's row. */
	Block: InputGroupBlock,
	displayName: "DelacourUI.Input.Group",
});
