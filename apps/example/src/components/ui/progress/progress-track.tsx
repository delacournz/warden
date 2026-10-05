import { type ReactElement, type ReactNode, useCallback } from "react";
import { type LayoutChangeEvent, View, type ViewProps } from "react-native";
import { useProgressPart } from "./progress.context";
import { progressVariants } from "./progress.variants";

export type ProgressTrackProps = Omit<ViewProps, "children"> & {
	/** The fill. */
	children?: ReactNode;
};

/**
 * The clipped, rounded groove the fill slides along.
 *
 * It measures its own width into the shared value the fill reads, because the
 * fill is positioned by a transform in points and a transform cannot name a
 * percentage. The clip is what turns a full-length bar parked off to the left
 * into a bar that appears to grow — see `progressVariants`.
 */
export function ProgressTrack({ className, onLayout, ...props }: ProgressTrackProps): ReactElement {
	const { color, size, isIndeterminate, trackSize } = useProgressPart("Progress.Track");

	const handleLayout = useCallback(
		(event: LayoutChangeEvent) => {
			trackSize.value = event.nativeEvent.layout.width;
			onLayout?.(event);
		},
		[onLayout, trackSize]
	);

	return (
		<View
			className={progressVariants({ color, isIndeterminate, size }).track({ className })}
			onLayout={handleLayout}
			{...props}
		/>
	);
}
ProgressTrack.displayName = "DelacourUI.Progress.Track";
