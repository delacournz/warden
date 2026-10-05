import { type ReactElement, useMemo } from "react";
import type { ViewProps } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { Separator, type SeparatorProps } from "@/components/ui/separator";
import { useTabsMotionPart, useTabsPart } from "./tabs.context";
import { resolveSeparatorIndices, resolveSeparatorOpacity, tabsVariants } from "./tabs.variants";

export type TabsSeparatorProps = Omit<ViewProps, "children"> & {
	/**
	 * The two tabs this rule sits between.
	 *
	 * Named rather than inferred: a separator is a leaf and cannot see its
	 * siblings, and having the row walk its children to work it out would put the
	 * ordering in a second place — the one thing this component keeps in exactly
	 * one.
	 */
	betweenValues: readonly [string, string];
	className?: string;
	/** Props for the rule itself, for a caller restyling it in place. */
	separatorProps?: Omit<SeparatorProps, "orientation">;
};

/**
 * A hairline between two tabs, which retreats as either one is approached.
 *
 * It renders a `Separator` rather than a second one-pixel rule of its own — the
 * line is already a component, and a second definition of it is a second thing to
 * keep in step. This part is the positioning and the fade.
 *
 * **The fade is driven by the pager's position, not by the settled value.** So the
 * rule withdraws as a finger drags a tab up against it and comes back if the drag
 * is abandoned, rather than blinking away at release — which is the whole reason
 * it is an animation and not a conditional render. `opacity` is not a layout
 * prop, so this costs nothing.
 *
 * A pair naming a tab nothing claims renders at full opacity and warns in
 * development: a separator that vanished for a reason unexplainable from the call
 * site would be worse than one that never fades.
 */
export function TabsSeparator({
	betweenValues,
	className,
	separatorProps,
	...props
}: TabsSeparatorProps): ReactElement {
	const { order, size, variant } = useTabsPart("Tabs.Separator");
	const { position } = useTabsMotionPart("Tabs.Separator");

	const { left, right } = useMemo(() => resolveSeparatorIndices(order, betweenValues), [order, betweenValues]);

	if (process.env.NODE_ENV !== "production" && order.length > 0 && (left < 0 || right < 0)) {
		console.warn(
			`Tabs.Separator: betweenValues [${betweenValues[0]}, ${betweenValues[1]}] names a tab this <Tabs> has no panel or trigger for, so the rule will never fade.`
		);
	}

	const fadeStyle = useAnimatedStyle(
		() => ({ opacity: resolveSeparatorOpacity(position.value, left, right) }),
		[left, right]
	);

	const slots = tabsVariants({ size, variant });

	// The slot is positioning and a height, and it goes on the wrapper: a vertical
	// `Separator` is `self-stretch`, so it takes its length from whatever holds it
	// rather than naming one — see ../separator/AGENTS.md.
	return (
		<Animated.View className={slots.separator({ className })} style={fadeStyle} {...props}>
			<Separator orientation="vertical" {...separatorProps} />
		</Animated.View>
	);
}
TabsSeparator.displayName = "DelacourUI.Tabs.Separator";
