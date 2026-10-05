import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { SharedValue } from "react-native-reanimated";
import type { ProgressRenderProps } from "./progress.types";
import type { ProgressColor, ProgressSize } from "./progress.variants";

/**
 * What a progress bar's parts read.
 *
 * **The track and the fill read only `ratio`, `isIndeterminate`, `color`, `size`
 * and `trackSize`.** That is deliberate: a meter is the same track and the same
 * fill with a different root deciding the ratio and the colour, so a root that
 * publishes this shape can reuse `Progress.Track` and `Progress.Fill` as they
 * stand. Nothing the parts draw reaches back to how the ratio was arrived at.
 */
export type ProgressContextValue = {
	/** Where the value sits in the range, clamped to 0–1, on the JS thread. */
	ratio: number;
	/** Loops a segment along the track instead of showing a value. */
	isIndeterminate: boolean;
	color: ProgressColor;
	size: ProgressSize;
	/** The track's own width, from its `onLayout`. `0` until it has been measured. */
	trackSize: SharedValue<number>;
	/** The settled state `Progress.Output` formats and a render function is handed. */
	renderProps: ProgressRenderProps;
};

const ProgressContext = createContext<ProgressContextValue | null>(null);

/**
 * Supplies one progress bar's state to its own parts.
 *
 * Lives in its own module, importing nothing but React and types, so a part can
 * read it without importing `./progress` — that import would close a cycle, and
 * Metro serves a partially initialised module for a cycle.
 */
export function ProgressProvider({
	value,
	children,
}: {
	value: ProgressContextValue;
	children: ReactNode;
}): ReactElement {
	return <ProgressContext value={value}>{children}</ProgressContext>;
}
ProgressProvider.displayName = "DelacourUI.Progress.Provider";

/** The enclosing progress bar's state, or null outside a `<Progress>`. */
export function useProgressContext(): ProgressContextValue | null {
	return use(ProgressContext);
}

/**
 * Reads the enclosing progress bar's state.
 *
 * For a custom readout or a custom fill that has to match the bar it sits in.
 * Throws outside one — use {@link useProgressContext} where the bar is optional.
 */
export function useProgress(): ProgressContextValue {
	const context = useProgressContext();
	if (!context) {
		throw new Error("useProgress must be called inside a <Progress>.");
	}
	return context;
}

/**
 * The enclosing bar's state, for a compound part that cannot work without one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useProgress}, whose error names the hook rather than a part.
 */
export function useProgressPart(component: string): ProgressContextValue {
	const context = useProgressContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Progress>.`);
	}
	return context;
}
