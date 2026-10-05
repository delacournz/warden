import type { ReactNode } from "react";

/**
 * What a render function inside a progress bar is handed.
 *
 * Shared by the root's context and `Progress.Output`, which is what puts it here
 * rather than in either one's own file — two consumers is the bar a
 * `{name}.types.ts` entry has to clear. See AGENTS.md.
 */
export type ProgressRenderProps = {
	/** The value as given, unclamped — the readout is the caller's to word. */
	value: number;
	minValue: number;
	maxValue: number;
	/** Where the value sits in the range, clamped to 0–1. */
	ratio: number;
	/** The readout's default text: `valueLabel`, or the formatted value. */
	formatted: string;
	isIndeterminate: boolean;
};

/** A part whose children may be written out or computed from the bar's state. */
export type ProgressRenderChildren = ReactNode | ((props: ProgressRenderProps) => ReactNode);
