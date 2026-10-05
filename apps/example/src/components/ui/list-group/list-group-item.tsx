import { Children, type ReactElement, type ReactNode, useMemo } from "react";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { useListGroupPart } from "./list-group.context";
import { listGroupVariants } from "./list-group.variants";
import { ListGroupItemContent } from "./list-group-item-content";
import { ListGroupItemTitle } from "./list-group-item-title";

export type ListGroupItemProps = Omit<PressableProps, "children" | "disabled"> & {
	isDisabled?: boolean;
	children?: ReactNode;
};

/**
 * One row of a list group.
 *
 * Plain string or number children are wrapped in a title inside a content
 * column; pass the compound parts when a row needs a prefix, a description or a
 * suffix. React Native cannot render a string outside a `<Text>`, so the wrap is
 * not a convenience — without it `<ListGroup.Item>Wi-Fi</ListGroup.Item>` would
 * crash.
 *
 * A row is a `Pressable`, so `feedback`, `haptic` and the rest come from there
 * rather than being restated here. Only the default differs: `fade`, because a
 * full-bleed row that scales reads as the whole card flexing rather than as one
 * row responding.
 */
export function ListGroupItem({
	feedback = "fade",
	isDisabled = false,
	className,
	children,
	...props
}: ListGroupItemProps): ReactElement {
	const { size } = useListGroupPart("ListGroup.Item");
	const content = useMemo(() => wrapTextChildren(children), [children]);

	return (
		<Pressable
			className={listGroupVariants({ isDisabled, size }).item({ className })}
			disabled={isDisabled}
			feedback={feedback}
			{...props}
		>
			{content}
		</Pressable>
	);
}
ListGroupItem.displayName = "DelacourUI.ListGroup.Item";

/**
 * Wraps bare text children in a title inside a content column.
 *
 * Consecutive strings and numbers are collected into a single title rather than
 * one each — `Row {index}` is one piece of text, and wrapping the parts
 * separately would space them apart by the row's gap.
 *
 * Lives here rather than with the root: it is the row that wraps its own text,
 * and importing it from `./list-group` would close a cycle back through the
 * root. See AGENTS.md rule 3.
 */
function wrapTextChildren(children: ReactNode): ReactNode {
	const items = Children.toArray(children);
	const output: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		output.push(
			<ListGroupItemContent key={`content-${output.length}`}>
				<ListGroupItemTitle>{run.join("")}</ListGroupItemTitle>
			</ListGroupItemContent>
		);
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
