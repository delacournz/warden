import { Children, type ReactElement, type ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { Separator } from "@/components/ui/separator";
import { Text } from "@/components/ui/text";
import { TextClassProvider } from "@/components/ui/text/text.context";
import { fieldVariants } from "./field.variants";

export type FieldSeparatorProps = Omit<ViewProps, "children"> & {
	className?: string;
	/** Optional label, drawn between two rules rather than on top of one. */
	children?: ReactNode;
};

/**
 * A rule between two sections of a form, optionally labelled.
 *
 * With children it draws **two rules with the label between them**, not one rule
 * with the label sitting on top. The web version absolutely-positions a single
 * rule and punches a hole in it with an opaque `bg-background` label, which is
 * only invisible while the separator sits on exactly that colour — put it on a
 * card, a sheet or a tinted section and the hole shows as a block of the wrong
 * shade. Two rules and a gap assume nothing about what is behind them.
 *
 * Hidden from assistive technology when it is unlabelled, for the reason
 * `Separator` itself is: a bare line carries nothing a screen reader can use. A
 * labelled one keeps its text, which is the part worth announcing.
 */
export function FieldSeparator({ className, children, ...props }: FieldSeparatorProps): ReactElement {
	const slots = fieldVariants();
	const lineClassName = slots.separatorLine();

	if (!hasContent(children)) {
		return <Separator className={className} {...props} />;
	}

	return (
		<View className={slots.separator({ className })} {...props}>
			<Separator className={lineClassName} />
			<TextClassProvider value={undefined}>{wrapTextChildren(children)}</TextClassProvider>
			<Separator className={lineClassName} />
		</View>
	);
}
FieldSeparator.displayName = "DelacourUI.Field.Separator";

/** Whether there is a label to make room for between the rules. */
function hasContent(children: ReactNode): boolean {
	return Children.toArray(children).some((child) => child !== "");
}

/**
 * Wraps a bare string label in a `Text.Caption`.
 *
 * React Native cannot render a string outside a `<Text>`, and
 * `<Field.Separator>Or</Field.Separator>` is the shortest thing anyone will
 * write. Consecutive strings collapse into one, so an interpolated label is a
 * single run rather than several spaced apart by the row's own gap.
 */
function wrapTextChildren(children: ReactNode): ReactNode {
	const items = Children.toArray(children);
	const output: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		output.push(<Text.Caption key={`label-${output.length}`}>{run.join("")}</Text.Caption>);
		run = [];
	};

	for (const child of items) {
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
