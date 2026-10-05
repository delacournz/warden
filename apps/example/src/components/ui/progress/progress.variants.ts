import type { VariantProps } from "tailwind-variants";
import { tv } from "@/lib/tv";
import type { TextSize } from "@/components/ui/text/text.variants";

/** What the filled part of the bar means. The slider's set, so the two name a colour alike. */
export const PROGRESS_COLORS = ["default", "primary", "success", "warning", "destructive", "info"] as const;

export const PROGRESS_SIZES = ["sm", "md", "lg"] as const;

export type ProgressColor = (typeof PROGRESS_COLORS)[number];
export type ProgressSize = (typeof PROGRESS_SIZES)[number];

/**
 * The axes a progress bar falls back to when nothing names one.
 *
 * Named once because two places read them — `defaultVariants` below and
 * {@link resolveProgressAxes}, which runs before `tv` is ever called.
 */
export const PROGRESS_DEFAULT_COLOR: ProgressColor = "default";
export const PROGRESS_DEFAULT_SIZE: ProgressSize = "md";

/** The range a progress bar covers when the caller names none. */
export const PROGRESS_MIN_VALUE = 0;
export const PROGRESS_MAX_VALUE = 100;

/**
 * How long the fill takes to reach a new value.
 *
 * Short enough that a bar fed every hundred milliseconds by an upload never
 * falls visibly behind, long enough that a jump from 20 to 60 reads as travel
 * rather than as a cut.
 */
export const PROGRESS_FILL_DURATION_MS = 320;

/** One pass of the indeterminate segment, from off the left edge to off the right. */
export const PROGRESS_INDETERMINATE_DURATION_MS = 1400;

/** The indeterminate segment's length, as a fraction of the track. */
export const PROGRESS_INDETERMINATE_SEGMENT = 0.4;

/**
 * The reduce-motion stand-in for the indeterminate sweep: the whole track fills
 * and breathes between these two opacities.
 *
 * Never down to zero — a bar that fades out entirely reads as the work having
 * stopped, which is the one thing an indeterminate bar must not say.
 */
export const PROGRESS_PULSE = { from: 0.35, to: 1, durationMs: 900 } as const;

/**
 * The `Text` size step each progress size hands its label and its readout.
 *
 * The slider's own map, restated rather than imported so this leaf imports no
 * other component's variants; a test pins the two together.
 */
export const PROGRESS_OUTPUT_TEXT_SIZE: Record<ProgressSize, TextSize> = { sm: "sm", md: "md", lg: "lg" };

/**
 * Styling for every part of a progress bar.
 *
 * One slotted `tv()` because `progress-label.tsx`, `progress-output.tsx`,
 * `progress-track.tsx` and `progress-fill.tsx` cannot import the root without
 * closing a cycle (AGENTS.md rule 3), yet all four read the same `color` and
 * `size`.
 *
 * **The colour paints the fill and never the track.** An empty bar is the same
 * chrome at every colour — the slider's groove, `bg-secondary` — and a test
 * pins that.
 *
 * **The fill is a full-length bar slid under a clipping track**, not a bar whose
 * width changes. Its position is a `translateX`, which is a transform — composited
 * on the UI thread with no layout pass per frame, where an animated `width`
 * re-lays the bar out every frame of every update. The track's `overflow-hidden`
 * and `rounded-full` are what make that read as a bar growing from the left: the
 * part parked beyond the start is clipped, and the leading end keeps its round
 * cap because it is the fill's own end rather than a cut.
 *
 * **The size is the track's thickness and nothing else.** There is no thumb to
 * keep flush and no touch target to pad, so these are plain spacing steps —
 * thinner than the slider's groove, because a bar you read is lighter than a
 * groove you grab.
 *
 * Free of React Native imports so it stays unit-testable — `bun test` cannot parse
 * React Native's Flow-typed source. See AGENTS.md.
 */
export const progressVariants = tv({
	slots: {
		/** The column holding the header and the track. */
		root: "w-full gap-2",
		/** The row a label and a readout share, when both are given. */
		header: "flex-row items-center justify-between gap-3",
		/** Handed to a `Text.Label`. Layout only. */
		label: "shrink",
		/** Handed to a `Text.Label`. Layout only. */
		output: "",
		/** The clipped, rounded groove the fill slides along. */
		track: "relative w-full overflow-hidden rounded-full bg-secondary",
		/** The painted bar. Its position is an animated transform, never a class. */
		fill: "absolute top-0 bottom-0 left-0 rounded-full",
	},
	variants: {
		size: {
			sm: { track: "h-1" },
			md: { track: "h-2" },
			lg: { track: "h-3" },
		},
		color: {
			default: { fill: "bg-foreground" },
			primary: { fill: "bg-primary" },
			success: { fill: "bg-success" },
			warning: { fill: "bg-warning" },
			destructive: { fill: "bg-destructive" },
			info: { fill: "bg-info" },
		},
		// The empty branches are load-bearing typing: `tv` types a map holding only
		// `true` as `true` rather than `boolean`.
		isIndeterminate: { true: {}, false: {} },
	},
	defaultVariants: {
		color: PROGRESS_DEFAULT_COLOR,
		size: PROGRESS_DEFAULT_SIZE,
		isIndeterminate: false,
	},
});

/**
 * Where a value sits in the range, as 0–1.
 *
 * Clamped rather than extrapolated, and `0` for a degenerate range or a value
 * that is not a finite number: a `NaN` written into a shared value freezes the
 * fill for good, and an upload that divides by a total it has not learned yet
 * produces exactly that.
 */
export function progressRatio(value: number, minValue: number, maxValue: number): number {
	"worklet";
	const span = maxValue - minValue;
	if (!(span > 0) || !Number.isFinite(value)) return 0;
	const ratio = (value - minValue) / span;
	return ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
}

/**
 * The fill's `translateX`: how far left of the track's start the full-length bar
 * is parked.
 *
 * A bar at `ratio` shows `ratio × trackSize` of itself, so it sits back by the
 * rest. `0` on an unmeasured track — the fill is hidden until the first layout,
 * so there is nothing to place.
 */
export function fillTranslate({ ratio, trackSize }: { ratio: number; trackSize: number }): number {
	"worklet";
	if (trackSize <= 0) return 0;
	const clamped = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
	return (clamped - 1) * trackSize;
}

/**
 * The indeterminate segment's box at one point in its loop.
 *
 * `phase` runs 0–1. At 0 the segment sits wholly off the track's left edge and at
 * 1 wholly off its right, so the frame where the loop restarts is never on screen
 * — a sweep that began at the track's start would pop into view every pass.
 */
export function indeterminateSegment({
	phase,
	segment,
	trackSize,
}: {
	phase: number;
	segment: number;
	trackSize: number;
}): { translate: number; width: number } {
	"worklet";
	if (trackSize <= 0) return { translate: 0, width: 0 };
	const width = segment * trackSize;
	return { translate: -width + phase * (trackSize + width), width };
}

/** What {@link formatProgressValue} and {@link resolveProgressAccessibility} read. */
export type ProgressFormatInput = {
	value: number;
	minValue: number;
	maxValue: number;
	formatOptions?: Intl.NumberFormatOptions;
};

/** Whether the readout speaks a percentage of the range, rather than the value itself. */
function isPercentFormat(formatOptions: Intl.NumberFormatOptions | undefined): boolean {
	return formatOptions?.style === undefined || formatOptions.style === "percent";
}

/**
 * The readout's default text.
 *
 * With no `formatOptions`, or a `percent` style, it is the share of the range —
 * `72%`, or `75%` for 18 of 24. A percent style formats the *ratio* rather than
 * the value, because `Intl` multiplies by a hundred and a value of 72 would read
 * `7,200%`. Any other style formats the value itself, so a budget reads `$1,250`.
 *
 * JS-thread only — `Intl` is not available to a worklet.
 */
export function formatProgressValue({ value, minValue, maxValue, formatOptions }: ProgressFormatInput): string {
	if (isPercentFormat(formatOptions)) {
		const format = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0, ...formatOptions, style: "percent" });
		return format.format(progressRatio(value, minValue, maxValue));
	}
	return new Intl.NumberFormat(undefined, formatOptions).format(value);
}

/** The accessibility surface a progress bar publishes on its root. */
export type ProgressAccessibility = {
	busy: boolean;
	value: { min: number; max: number; now: number; text: string } | undefined;
};

/**
 * What assistive technology is told.
 *
 * **The spoken text names the range, not only the share of it.** A bar over
 * 0–100 reads its percentage; any other range reads `18 of 24`, formatted the way
 * the readout formats the value — because the count is what the screen is about,
 * and "seventy-five percent" makes the listener do the division back.
 * `valueLabel` replaces both.
 *
 * **An indeterminate bar reports `busy` and no value at all.** A `now` of zero
 * would be read out as "zero percent", which is a lie about work that is under
 * way.
 */
export function resolveProgressAccessibility({
	value,
	minValue,
	maxValue,
	formatOptions,
	isIndeterminate,
	valueLabel,
}: ProgressFormatInput & { isIndeterminate: boolean; valueLabel?: string }): ProgressAccessibility {
	if (isIndeterminate) return { busy: true, value: undefined };

	const ratio = progressRatio(value, minValue, maxValue);
	const now = minValue + ratio * (maxValue - minValue);
	const isHundredScale = minValue === 0 && maxValue === 100;

	let text = valueLabel;
	if (text === undefined) {
		if (isHundredScale && isPercentFormat(formatOptions)) {
			text = formatProgressValue({ formatOptions, maxValue, minValue, value });
		} else {
			const format = new Intl.NumberFormat(
				undefined,
				isPercentFormat(formatOptions) ? { maximumFractionDigits: 2 } : formatOptions
			);
			text = `${format.format(now)} of ${format.format(maxValue)}`;
		}
	}

	return { busy: false, value: { max: maxValue, min: minValue, now, text } };
}

/** What a progress bar was given at its own call site. */
export type ProgressOwnAxes = {
	color?: ProgressColor;
	size?: ProgressSize;
	isIndeterminate?: boolean;
};

/** Every axis settled, ready to hand to {@link progressVariants} and to context. */
export type ProgressAxes = Required<ProgressOwnAxes>;

/**
 * Settles a progress bar's axes.
 *
 * One rung, deliberately: a progress bar is an output, not a form control, so an
 * enclosing `Field` has no disabled or invalid state to hand it. `??` rather than
 * `||`, so an explicit `false` is a value rather than an absence.
 */
export function resolveProgressAxes(own: ProgressOwnAxes): ProgressAxes {
	return {
		color: own.color ?? PROGRESS_DEFAULT_COLOR,
		isIndeterminate: own.isIndeterminate ?? false,
		size: own.size ?? PROGRESS_DEFAULT_SIZE,
	};
}

export type ProgressVariantProps = VariantProps<typeof progressVariants>;
