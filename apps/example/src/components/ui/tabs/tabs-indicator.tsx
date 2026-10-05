import type { ReactElement, ReactNode } from "react";
import type { ViewProps } from "react-native";
import Animated, { Extrapolation, interpolate, type SharedValue, useAnimatedStyle } from "react-native-reanimated";
import { useTabsListPart, useTabsMotionPart, useTabsPart } from "./tabs.context";
import { type TabsSize, type TabsVariant, tabsVariants } from "./tabs.variants";

export type TabsIndicatorRenderProps = {
	/** Where the pager sits in tab-index space, on the UI thread. */
	position: SharedValue<number>;
	variant: TabsVariant;
	size: TabsSize;
};

export type TabsIndicatorProps = Omit<ViewProps, "children"> & {
	className?: string;
	/**
	 * Composed inside the capsule, which keeps its own fill, position and size.
	 *
	 * To change the capsule itself — an outline instead of a fill, a different
	 * colour — pass a `className`; it merges last, so `bg-transparent` beats the
	 * variant's own fill. Children are for what a class cannot say: a gradient, a
	 * second layer, something that reads `position` for itself.
	 */
	children?: ReactNode | ((props: TabsIndicatorRenderProps) => ReactNode);
};

/**
 * The one layer that slides, and the only place a tab's motion is drawn.
 *
 * Write it out as the first child of the row it belongs to — inside
 * `Tabs.ScrollView` when there is one, inside `Tabs.List` when there is not. It is
 * absolutely positioned in that row's own space, which is exactly the space every
 * `Tabs.Trigger` measures itself into, so the two need no arithmetic between them.
 *
 * **It animates `width` alongside `translateX`, deliberately rather than
 * `scaleX`.** A scale is cheaper — a pure transform, no layout pass — and it is
 * wrong here three times over: `rounded-full` stretches into an ellipse at the
 * 2.3× a short tab to a long one asks for, a border thickens on two edges and not
 * the other two, and any children a caller passes are squashed with it, which no
 * counter-scale can fix across an arbitrary subtree. The cost is one layout of
 * this node's own box per frame, and it is bounded: the indicator is absolutely
 * positioned, so its size change never dirties a sibling and the row's layout
 * stays settled. `Checkbox` already animates a width every toggle for the same
 * kind of reason.
 *
 * If a caller ever does put a deep subtree inside one, the fix is to give that
 * subtree a fixed size and let the indicator's width move around it rather than
 * through it.
 *
 * **Children are composed inside it, not in place of it** — `Radio.Indicator`'s
 * shape, where the ring stays the radio's and only the dot is the caller's. The
 * capsule's own fill comes from the variant and its `className` merges last, so
 * an outline treatment is `className="border-2 border-primary bg-transparent"`
 * rather than a child.
 *
 * **It reads the UI thread and nothing else**, which is why the shared values it
 * needs come from a context of their own: the bar's selection context changes
 * identity on every tab change, and this component must not re-render for one.
 */
export function TabsIndicator({ className, children, style, ...props }: TabsIndicatorProps): ReactElement {
	const { variant, size } = useTabsPart("Tabs.Indicator");
	const { position } = useTabsMotionPart("Tabs.Indicator");
	const { tracks } = useTabsListPart("Tabs.Indicator");

	const frameStyle = useAnimatedStyle(() => {
		const current = tracks.value;
		// Nothing measured yet. `opacity: 0` rather than an early return that names
		// no opacity: a style which stops naming a prop leaves the last value it
		// wrote in place, so the indicator would freeze wherever it last sat instead
		// of getting out of the way.
		if (!current) return { opacity: 0, transform: [{ translateX: 0 }], width: 0 };

		return {
			opacity: 1,
			transform: [{ translateX: interpolate(position.value, current.index, current.x, Extrapolation.CLAMP) }],
			width: interpolate(position.value, current.index, current.width, Extrapolation.CLAMP),
		};
	});

	const slots = tabsVariants({ size, variant });

	return (
		<Animated.View
			// A decoration, and announcing it would put an actionless element in front
			// of every tab a screen reader walks.
			accessibilityElementsHidden
			className={slots.indicator({ className })}
			importantForAccessibility="no-hide-descendants"
			pointerEvents="none"
			style={[frameStyle, style]}
			{...props}
		>
			{typeof children === "function" ? children({ position, size, variant }) : children}
		</Animated.View>
	);
}
TabsIndicator.displayName = "DelacourUI.Tabs.Indicator";
