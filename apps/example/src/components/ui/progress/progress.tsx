import { type ReactElement, type ReactNode, useMemo } from "react";
import { View, type ViewProps } from "react-native";
import { useSharedValue } from "react-native-reanimated";
import { type ProgressContextValue, ProgressProvider } from "./progress.context";
import type { ProgressRenderProps } from "./progress.types";
import {
	formatProgressValue,
	PROGRESS_MAX_VALUE,
	PROGRESS_MIN_VALUE,
	type ProgressColor,
	type ProgressSize,
	progressRatio,
	progressVariants,
	resolveProgressAccessibility,
	resolveProgressAxes,
} from "./progress.variants";
import { ProgressFill } from "./progress-fill";
import { ProgressHeader } from "./progress-header";
import { ProgressLabel } from "./progress-label";
import { ProgressOutput } from "./progress-output";
import { ProgressTrack } from "./progress-track";

export type ProgressProps = Omit<ViewProps, "children"> & {
	/** How far along, between `minValue` and `maxValue`. Ignored while indeterminate. */
	value?: number;
	minValue?: number;
	maxValue?: number;
	/** Loops a segment along the track, for work whose length is not known yet. */
	isIndeterminate?: boolean;
	/**
	 * Passed to `Intl.NumberFormat` by `Progress.Output` and the spoken value.
	 * With none, or a `percent` style, the readout is the share of the range.
	 */
	formatOptions?: Intl.NumberFormatOptions;
	/** Replaces the formatted readout, on screen and to assistive technology. */
	valueLabel?: string;
	/** What the filled part of the track means. */
	color?: ProgressColor;
	size?: ProgressSize;
	/** The anatomy. With none, the bar draws a bare track and fill. */
	children?: ReactNode;
};

function ProgressRoot({
	value = PROGRESS_MIN_VALUE,
	minValue = PROGRESS_MIN_VALUE,
	maxValue = PROGRESS_MAX_VALUE,
	isIndeterminate,
	formatOptions,
	valueLabel,
	color,
	size,
	className,
	children,
	...props
}: ProgressProps): ReactElement {
	const axes = resolveProgressAxes({ color, isIndeterminate, size });
	const trackSize = useSharedValue(0);

	const ratio = progressRatio(value, minValue, maxValue);

	const formatted = useMemo(
		() => valueLabel ?? formatProgressValue({ formatOptions, maxValue, minValue, value }),
		[formatOptions, maxValue, minValue, value, valueLabel]
	);

	const accessibility = useMemo(
		() =>
			resolveProgressAccessibility({
				formatOptions,
				isIndeterminate: axes.isIndeterminate,
				maxValue,
				minValue,
				value,
				valueLabel,
			}),
		[axes.isIndeterminate, formatOptions, maxValue, minValue, value, valueLabel]
	);

	const renderProps = useMemo<ProgressRenderProps>(
		() => ({ formatted, isIndeterminate: axes.isIndeterminate, maxValue, minValue, ratio, value }),
		[axes.isIndeterminate, formatted, maxValue, minValue, ratio, value]
	);

	const context = useMemo<ProgressContextValue>(
		() => ({
			color: axes.color,
			isIndeterminate: axes.isIndeterminate,
			ratio,
			renderProps,
			size: axes.size,
			trackSize,
		}),
		[axes.color, axes.isIndeterminate, axes.size, ratio, renderProps, trackSize]
	);

	// A bare `<Progress value={40} />` draws the bar. A compound root with no
	// default anatomy draws nothing at all, which is a failure with no error.
	const content = children ?? (
		<ProgressTrack>
			<ProgressFill />
		</ProgressTrack>
	);

	return (
		<ProgressProvider value={context}>
			<View
				accessibilityRole="progressbar"
				accessibilityState={{ busy: accessibility.busy }}
				accessibilityValue={accessibility.value}
				accessible
				className={progressVariants(axes).root({ className })}
				{...props}
			>
				{content}
			</View>
		</ProgressProvider>
	);
}

/**
 * How far a task has got — or, indeterminate, that it is under way.
 *
 * The anatomy is written out: a `Progress.Track` holding a `Progress.Fill`, with
 * an optional `Progress.Header` above it carrying a `Progress.Label` and a
 * `Progress.Output`. A bare `<Progress value={40} />` draws the track and fill on
 * its own.
 *
 * **The fill animates on the UI thread.** A new value starts one timing and the
 * frames never touch React. `isIndeterminate` loops a segment along the track
 * instead, and with the system's reduce-motion setting on it breathes in place
 * rather than travelling.
 *
 * **It is one accessible element with the `progressbar` role.** The range and
 * the value are published as `accessibilityValue`, spoken as `72%` over 0–100
 * and as `18 of 24` over any other range; a `Progress.Label` inside it is its
 * name. An indeterminate bar reports `busy` and no value.
 *
 * It is not a control, so there is no disabled or invalid state and it takes
 * nothing from an enclosing `Field`. A bar that has failed is `color="destructive"`.
 *
 * @example
 * <Progress value={40} />
 *
 * @example
 * <Progress color="success" value={uploaded} maxValue={total} formatOptions={{ style: "unit", unit: "megabyte" }}>
 *   <Progress.Header>
 *     <Progress.Label>Uploading</Progress.Label>
 *     <Progress.Output />
 *   </Progress.Header>
 *   <Progress.Track>
 *     <Progress.Fill />
 *   </Progress.Track>
 * </Progress>
 *
 * @example
 * <Progress accessibilityLabel="Syncing" isIndeterminate />
 */
export const Progress = Object.assign(ProgressRoot, {
	/** The row above the track: a label at the start, a readout at the end. */
	Header: ProgressHeader,
	/** What the bar is measuring. Read as the bar's accessible name. */
	Label: ProgressLabel,
	/** The value, formatted. Give it a function to word it yourself. */
	Output: ProgressOutput,
	/** The clipped groove the fill slides along. */
	Track: ProgressTrack,
	/** The painted bar — a value, or a looping segment while indeterminate. */
	Fill: ProgressFill,
	displayName: "DelacourUI.Progress",
});
