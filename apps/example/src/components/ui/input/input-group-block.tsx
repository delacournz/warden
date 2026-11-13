import { type ReactElement, type ReactNode, useMemo } from "react";
import { View } from "react-native";
import { IconDefaultsProvider } from "@/components/ui/icon";
import { TextClassProvider } from "@/components/ui/text/text.context";
import {
	InputGroupPlacementProvider,
	useInputGroupPart,
	useInputGroupPlacement,
	useIsOuterInputGroupBlock,
} from "./input.context";
import { INPUT_DECORATOR_ICON_TOKEN, INPUT_INVALID_DECORATOR_ICON_TOKEN, inputVariants } from "./input.variants";
import { wrapTextChildren } from "./input-group-decorator";

export type InputGroupBlockProps = {
	/** `start` renders above the field's row, `end` below it. */
	position: "start" | "end";
	className?: string;
	children?: ReactNode;
};

/**
 * A full-width section of the group's box, above or below the field — a
 * toolbar, a row of attachments, a counter and a Send button.
 *
 * It sits inside the one box rather than beside it: one border, one focus ring,
 * one invalid state around the field and everything stacked with it. Its
 * presence turns the box's fixed height into a floor; the field's row is
 * unchanged, so a single-line field stays centred in it.
 *
 * Must be a direct child of `Input.Group` — the group sorts its children into
 * sections as it renders, so the box is laid out right in the first frame. It
 * draws no border of its own; an `Input.Group.Separator` beside it draws one
 * when the section should be divided rather than flush.
 *
 * Bare text and `Icon`s inside take the decorators' muted treatment, and turn
 * destructive with the group. A `Button` keeps its own.
 *
 * @example
 * <Input.Group>
 *   <Textarea rows={3} placeholder="Message" />
 *   <Input.Group.Block position="end">
 *     <Input.Group.Button variant="secondary" onPress={send}>Send</Input.Group.Button>
 *   </Input.Group.Block>
 * </Input.Group>
 */
export function InputGroupBlock({ position, className, children }: InputGroupBlockProps): ReactElement {
	const { isInvalid, size } = useInputGroupPart("Input.Group.Block");
	const placement = useInputGroupPlacement();
	// Only the block against the border cancels the box's padding. Another
	// block in the same section would be pulled over what sits beside it.
	const isOuter = useIsOuterInputGroupBlock();
	const slots = inputVariants({ blockPosition: isOuter ? position : "none", isInvalid, size });

	if (process.env.NODE_ENV !== "production" && placement === "row") {
		console.warn(
			"Input.Group.Block: a block must be a direct child of <Input.Group>. Rendered from inside a wrapper it lands in the field's row instead of above or below it."
		);
	}

	const iconClassName = slots.decoratorIcon();
	const iconDefaults = useMemo(
		() => ({
			className: iconClassName,
			color: isInvalid ? INPUT_INVALID_DECORATOR_ICON_TOKEN : INPUT_DECORATOR_ICON_TOKEN,
		}),
		[iconClassName, isInvalid]
	);

	return (
		<View accessible={false} className={slots.block({ className })}>
			<InputGroupPlacementProvider value="row">
				<IconDefaultsProvider value={iconDefaults}>
					<TextClassProvider value={slots.decoratorText()}>{wrapTextChildren(children)}</TextClassProvider>
				</IconDefaultsProvider>
			</InputGroupPlacementProvider>
		</View>
	);
}
InputGroupBlock.displayName = "DelacourUI.Input.Group.Block";
