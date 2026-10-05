import type { ReactElement, ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { useTabsPart } from "./tabs.context";
import { resolveContentAccessibility, tabsVariants } from "./tabs.variants";

export type TabsContentRenderProps = {
	/** Whether this panel's tab is the settled selection. */
	isSelected: boolean;
	/** What this panel is called. */
	value: string;
};

export type TabsContentProps = Omit<ViewProps, "children"> & {
	/** Identifies the panel to the trigger that selects it. Required. */
	value: string;
	className?: string;
	/**
	 * The panel, or a function called with its own selected state.
	 *
	 * The function is how a panel is made lazy — `{({ isSelected }) => isSelected ?
	 * <Expensive /> : null}` — at the caller's discretion, per panel. There is no
	 * `isLazy` prop because "lazy" is not one thing: a form wants to stay mounted,
	 * a video wants to stop, and a report wants never to have been built.
	 */
	children?: ReactNode | ((props: TabsContentRenderProps) => ReactNode);
};

/**
 * One panel, exactly one viewport wide.
 *
 * **Panels must be direct children of `<Tabs>`.** Their source order is the order
 * of record — it is what the pager translates through and what the indicator
 * interpolates over — and the root reads it by walking its own children, the way
 * `ListGroup` finds the rows it puts dividers between.
 *
 * **Every panel is mounted, whether or not the bar is swipeable.** You cannot drag
 * to a panel that does not exist, so mounting is not a setting `isSwipeable` gets
 * to change as a side effect; and a panel that unmounted on every tab change would
 * lose a half-filled form, a scroll position and a playing video with it. What an
 * unmounting panel never has to think about is the cost of staying: mounted
 * content is content a screen reader will read and a finger can reach, so an
 * unselected panel says it is not there through both platforms' props at once.
 */
export function TabsContent({ value, className, children, ...props }: TabsContentProps): ReactElement {
	const { value: selected, size, variant } = useTabsPart("Tabs.Content");
	const isSelected = selected === value;
	const slots = tabsVariants({ size, variant });

	return (
		// No `accessibilityRole`: React Native has no `tabpanel`, and the roles it
		// does have all describe controls. The panel is a container, and the two
		// props below are what actually keep an unselected one out of the way.
		<View
			className={slots.page({ className })}
			// Driven by the settled selection, never by the visual one: a screen reader
			// must not walk into a panel that is halfway across the screen.
			{...resolveContentAccessibility(isSelected)}
			pointerEvents={isSelected ? "auto" : "none"}
			{...props}
		>
			{typeof children === "function" ? children({ isSelected, value }) : children}
		</View>
	);
}
TabsContent.displayName = "DelacourUI.Tabs.Content";
