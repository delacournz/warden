import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { SharedValue } from "react-native-reanimated";
import type { SwitchColor, SwitchSize } from "./switch.variants";

export type SwitchContextValue = {
	color: SwitchColor;
	size: SwitchSize;
	/** Whether the switch is on, on the **JS thread** — what accessibility reads. */
	isSelected: boolean;
	isDisabled: boolean;
	isInvalid: boolean;
	/**
	 * Where the thumb is, on the **UI thread**: `0` at the leading edge, `1` at
	 * the trailing one.
	 *
	 * The one value every animated style on this control reads — the thumb's
	 * position and colour, the track's colour, and both content layers' opacity.
	 * One source rather than four, so they cannot drift out of step by a frame.
	 *
	 * It agrees with {@link SwitchContextValue.isSelected} at rest and disagrees
	 * for the whole of a drag, which is the entire reason the drag never waits on
	 * React.
	 */
	progress: SharedValue<number>;
	/** The track's own width, from its `onLayout`. `0` until it has been measured. */
	trackWidth: SharedValue<number>;
	/** The thumb's width, from its `onLayout`. `0` until it has been measured. */
	thumbWidth: SharedValue<number>;
};

const SwitchContext = createContext<SwitchContextValue | null>(null);

/**
 * Supplies one switch's settled state and shared values to its own parts.
 *
 * Lives in its own module, importing nothing but React and types, so a part can
 * read it without importing `./switch`. That import would close a cycle, and
 * Metro serves a partially initialised module for a cycle — leaving the context
 * `undefined` at import time and red-boxing the app on a cold start.
 */
export function SwitchProvider({ value, children }: { value: SwitchContextValue; children: ReactNode }): ReactElement {
	return <SwitchContext value={value}>{children}</SwitchContext>;
}
SwitchProvider.displayName = "DelacourUI.Switch.Provider";

/** The enclosing switch's state, or null outside a `<Switch>`. */
export function useSwitchContext(): SwitchContextValue | null {
	return use(SwitchContext);
}

/**
 * Reads the enclosing switch's settled state.
 *
 * Lets a custom child style itself to match without the switch having to pass
 * props down through every slot. Throws outside a `<Switch>` — use
 * {@link useSwitchContext} where the enclosing switch is optional.
 */
export function useSwitch(): SwitchContextValue {
	const context = useSwitchContext();
	if (!context) {
		throw new Error("useSwitch must be called inside a <Switch>.");
	}
	return context;
}

/**
 * The enclosing switch's state, for a compound part that cannot work without one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useSwitch}, whose error message names the hook rather
 * than a part.
 */
export function useSwitchPart(component: string): SwitchContextValue {
	const context = useSwitchContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Switch>.`);
	}
	return context;
}
