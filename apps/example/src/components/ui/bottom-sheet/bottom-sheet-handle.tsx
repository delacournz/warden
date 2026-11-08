import {
	BottomSheet as Headless,
	type BottomSheetHandleProps as HeadlessProps,
} from "@delacour/react-native-bottom-sheet";
import type { ReactElement } from "react";
import { type StyleProp, View, type ViewStyle } from "react-native";
import { withUniwind } from "uniwind";
import { bottomSheetVariants } from "./bottom-sheet.variants";

type StyledHandleComponent = (props: HeadlessProps & { className?: string }) => ReactElement | null;

// Built at module scope, or every render mints a new component type and the
// engine's pan re-attaches to a fresh view.
const StyledHandle = withUniwind(Headless.Handle) as unknown as StyledHandleComponent;

export type BottomSheetHandleProps = HeadlessProps & {
	className?: string;
	/** Classes for the grabber itself. */
	indicatorClassName?: string;
	indicatorStyle?: StyleProp<ViewStyle>;
};

/**
 * The grabber's row.
 *
 * The engine's handle draws nothing of its own: it owns the pan, measures
 * itself into the sheet's height, and is the adjustable element a screen
 * reader steps through the snap points with. This puts the pill inside it, and
 * classes on both.
 *
 * Pass children to replace the pill; the row, the pan and the accessibility
 * stay.
 *
 * @example
 * <BottomSheet.Handle indicatorClassName="bg-primary" />
 */
export function BottomSheetHandle({
	children,
	className,
	indicatorClassName,
	indicatorStyle,
	...props
}: BottomSheetHandleProps): ReactElement {
	const slots = bottomSheetVariants();

	return (
		<StyledHandle className={slots.handle({ className })} {...props}>
			{children ?? <View className={slots.handleIndicator({ className: indicatorClassName })} style={indicatorStyle} />}
		</StyledHandle>
	);
}
BottomSheetHandle.displayName = "DelacourUI.BottomSheet.Handle";
