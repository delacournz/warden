import {
	BottomSheet as Headless,
	type BottomSheetScrollViewProps as HeadlessProps,
	useBottomSheetInternal,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement, ReactNode } from "react";
import { View } from "react-native";
import { withUniwind } from "uniwind";
import { cn } from "@/lib/cn";
import { BOTTOM_SHEET_FOOTER_GAP, bottomSheetVariants } from "./bottom-sheet.variants";

/**
 * The one class prop this file uses, restated so the props survive the wrapper.
 *
 * `withUniwind`'s return type maps over a component's props, and over a
 * scrollable's animated ones it collapses to a single entry. Writing the
 * signature out keeps them, the way `Screen.LegendList` already has to.
 *
 * `contentContainerClassName` is deliberately absent even though the wrapper
 * adds one at runtime — see the component's doc comment.
 */
type StyledScrollViewComponent = (props: HeadlessProps & { className?: string }) => ReactElement | null;

// Third-party to Uniwind, so `className` needs the wrapper — built at module
// scope or every render mints a new component type and remounts the list.
const StyledScrollView = withUniwind(Headless.ScrollView) as unknown as StyledScrollViewComponent;

export type BottomSheetScrollViewProps = Omit<HeadlessProps, "children"> & {
	className?: string;
	/** Classes for the padded box the children sit in. */
	contentContainerClassName?: string;
	children?: ReactNode;
};

/**
 * A scrolling body.
 *
 * Use this rather than a plain `ScrollView`: the engine's scrollable and the
 * sheet's pan share a finger — below the highest snap point the list is held and
 * the drag moves the sheet, at the highest the list scrolls, and a drag down
 * from the top hands back to the sheet. A React Native `ScrollView` in here has
 * no such arrangement.
 *
 * **It needs no `snapPoints` and no `dynamicSizing={false}`.** The list
 * reports its content size, and that is the dynamic snap point: six rows make a
 * short sheet, forty make one capped at `maxDynamicContentSize` that scrolls
 * inside the cap. Explicit `snapPoints` on the root still work, for a height
 * that is a decision rather than a measurement.
 *
 * The classes go on an inner `View`, not on the engine's content container,
 * so the one style this component writes there — the gap that holds the last
 * row off a pinned footer's hairline — has a single writer. The engine already
 * clamps the list above a sticky footer and the safe-area band, so nothing
 * else is reserved here.
 *
 * @example
 * <BottomSheet maxDynamicContentSize={420}>
 *   …
 *   <BottomSheet.ScrollView>{rows}</BottomSheet.ScrollView>
 * </BottomSheet>
 */
export function BottomSheetScrollView({
	className,
	contentContainerClassName,
	contentContainerStyle,
	children,
	...props
}: BottomSheetScrollViewProps): ReactElement {
	const { hasFooter } = useBottomSheetInternal();

	return (
		<StyledScrollView
			className={cn(className)}
			contentContainerStyle={[{ paddingBottom: hasFooter ? BOTTOM_SHEET_FOOTER_GAP : 0 }, contentContainerStyle]}
			{...props}
		>
			<View className={bottomSheetVariants().scrollContent({ className: contentContainerClassName })}>{children}</View>
		</StyledScrollView>
	);
}
BottomSheetScrollView.displayName = "DelacourUI.BottomSheet.ScrollView";
