import { type ReactElement, type ReactNode, useMemo } from "react";
import type { AccessibilityState } from "react-native";
import Animated from "react-native-reanimated";
import { wrapTextChildren } from "@/lib/wrap-text-children";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { useListGroupPart } from "./list-group.context";
import { listGroupVariants, resolveListGroupItemRender } from "./list-group.variants";
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
 * Give it an `onPress` or `onLongPress` and it is a `Pressable`, announced as a
 * button — disabled too, when it keeps the role and reports `disabled`. Leave
 * both off and it is a plain view with the same layout, no role and no press
 * feedback, so a static Settings row never claims to be a control.
 * `resolveListGroupItemRender` makes that call.
 *
 * `feedback`, `haptic` and the rest come from `Pressable` rather than being
 * restated here. Only the default differs: `fade`, because a full-bleed row
 * that scales reads as the whole card flexing rather than as one row
 * responding.
 */
export function ListGroupItem({
	feedback = "fade",
	isDisabled = false,
	haptic,
	pressedScale,
	pressedOpacity,
	busy,
	asChild,
	onPress,
	onLongPress,
	accessibilityState,
	className,
	children,
	...props
}: ListGroupItemProps): ReactElement {
	const { size } = useListGroupPart("ListGroup.Item");
	const content = useMemo(() => wrapListGroupItemText(children, asChild), [asChild, children]);
	const itemClassName = listGroupVariants({ isDisabled, size }).item({ className });

	if (resolveListGroupItemRender({ isDisabled, onLongPress, onPress }) === "pressable") {
		return (
			<Pressable
				accessibilityState={accessibilityState}
				asChild={asChild}
				busy={busy}
				className={itemClassName}
				disabled={isDisabled}
				feedback={feedback}
				haptic={haptic}
				onLongPress={onLongPress}
				onPress={onPress}
				pressedOpacity={pressedOpacity}
				pressedScale={pressedScale}
				{...props}
			>
				{content}
			</Pressable>
		);
	}

	const state: AccessibilityState = { ...accessibilityState, busy, disabled: isDisabled };

	return (
		<Animated.View accessibilityState={state} className={itemClassName} {...props}>
			{content}
		</Animated.View>
	);
}
ListGroupItem.displayName = "DelacourUI.ListGroup.Item";

/**
 * Wraps bare text children in a title inside a content column.
 *
 * Consecutive strings and numbers are collected into a single title rather than
 * one each — `Row {index}` is one piece of text, and wrapping the parts
 * separately would space them apart by the row's gap. A single child, and every
 * child under `asChild`, comes back untouched: `Pressable` with `asChild` hands
 * its children to `Children.only`, which rejects any array. The shared
 * `wrapTextChildren` holds both rules and their tests.
 *
 * Lives here rather than with the root: it is the row that wraps its own text,
 * and importing it from `./list-group` would close a cycle back through the
 * root. See AGENTS.md rule 3.
 */
function wrapListGroupItemText(children: ReactNode, asChild: boolean | undefined): ReactNode {
	return wrapTextChildren(
		children,
		(text, key) => (
			<ListGroupItemContent key={key}>
				<ListGroupItemTitle>{text}</ListGroupItemTitle>
			</ListGroupItemContent>
		),
		{ asChild }
	);
}
