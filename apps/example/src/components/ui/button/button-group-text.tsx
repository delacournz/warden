import { Children, type ReactElement, type ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { IconDefaultsProvider } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { TextClassProvider } from "@/components/ui/text/text.context";
import { useButtonGroupItemContext } from "./button.context";
import {
	BUTTON_FOREGROUND_TOKEN,
	type ButtonVariant,
	buttonVariants,
	resolveGroupedButtonSize,
} from "./button.variants";

export type ButtonGroupTextProps = ViewProps & {
	/** Paint for the chunk. Falls back to the group's, then to `secondary`. */
	variant?: ButtonVariant;
	className?: string;
	children?: ReactNode;
};

/**
 * A chunk of a group that says something rather than doing something.
 *
 * A member like any other — it reads the same item context a `Button` does, so
 * it squares the corners crossing its seams and overlaps its neighbour without
 * knowing anything about where it sits.
 *
 * It draws the button's own chrome rather than chrome of its own, which is what
 * keeps its height, padding and corner identical to the buttons beside it: those
 * five values come off one axis in `buttonVariants`, and restating any of them
 * here is how a row stops lining up three tokens later.
 *
 * `secondary` rather than `primary` when nothing names a variant, because a
 * chunk that cannot be pressed should not wear the group's action paint. A group
 * that *does* name one is followed, so an outline group reads as one piece.
 *
 * Bare text children are wrapped in a `Text`, since React Native cannot render a
 * string outside one. Composed content inherits the same icon size and label
 * treatment a button publishes, so an `Icon` beside the text needs nothing.
 */
export function ButtonGroupText({ variant, className, children, ...props }: ButtonGroupTextProps): ReactElement {
	const item = useButtonGroupItemContext();
	const resolvedVariant = variant ?? item?.variant ?? "secondary";
	const slots = buttonVariants({
		groupPosition: item?.position ?? "none",
		isSeamed: item?.isSeamed ?? false,
		orientation: item?.orientation ?? "horizontal",
		size: resolveGroupedButtonSize(undefined, item?.size),
		variant: resolvedVariant,
	});

	const label = slots.label();

	return (
		<View className={slots.root({ className })} {...props}>
			<IconDefaultsProvider value={{ className: slots.icon(), color: BUTTON_FOREGROUND_TOKEN[resolvedVariant] }}>
				<TextClassProvider value={label}>{wrapTextChildren(children, label)}</TextClassProvider>
			</IconDefaultsProvider>
		</View>
	);
}
ButtonGroupText.displayName = "DelacourUI.Button.Group.Text";

/**
 * Wraps bare text children in a `Text`.
 *
 * React Native cannot render a string outside a `<Text>`, so
 * `<Button.Group.Text>3 of 7</Button.Group.Text>` would otherwise crash.
 * Consecutive strings and numbers are collected into a single one rather than
 * one each — `Page {n}` is one piece of text, and wrapping the parts separately
 * would space them apart by the root's gap.
 *
 * Lives beside its caller rather than in the group's root, which inserts
 * nothing: a helper follows the component that uses it.
 */
function wrapTextChildren(children: ReactNode, className: string): ReactNode {
	const output: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		output.push(
			<Text className={className} key={`label-${output.length}`}>
				{run.join("")}
			</Text>
		);
		run = [];
	};

	for (const child of Children.toArray(children)) {
		if (typeof child === "string" || typeof child === "number") {
			run.push(child);
			continue;
		}
		flushRun();
		output.push(child);
	}
	flushRun();

	return output;
}
