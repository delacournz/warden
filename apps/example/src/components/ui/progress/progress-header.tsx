import type { ReactElement } from "react";
import { View, type ViewProps } from "react-native";
import { useProgressPart } from "./progress.context";
import { progressVariants } from "./progress.variants";

export type ProgressHeaderProps = ViewProps;

/**
 * The row above the track: a label at the start, a readout at the end.
 *
 * A part rather than a `View` the caller writes because every labelled bar
 * wants exactly this row, and a hand-written one drifts — a missing `gap` lets a
 * long label run into the percentage.
 */
export function ProgressHeader({ className, ...props }: ProgressHeaderProps): ReactElement {
	const { color, size, isIndeterminate } = useProgressPart("Progress.Header");
	return <View className={progressVariants({ color, isIndeterminate, size }).header({ className })} {...props} />;
}
ProgressHeader.displayName = "DelacourUI.Progress.Header";
