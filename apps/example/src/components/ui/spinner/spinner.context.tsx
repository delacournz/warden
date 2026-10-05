import { createContext, type ReactElement, type ReactNode, use } from "react";

export type SpinnerContextValue = {
	/** Resolved colour value, ready for an SVG stroke. */
	color: string | undefined;
	/** Rotation speed multiplier. 1 is one full turn per 900ms. */
	speed: number;
	/** Whether the spinner is showing. */
	isLoading: boolean;
};

const SpinnerContext = createContext<SpinnerContextValue | null>(null);

/**
 * Supplies the enclosing spinner's resolved colour and speed to its subtree.
 *
 * Lives in its own module, importing nothing at all, so the parts the spinner
 * renders — `Spinner.Content` and the default arc glyph — can read it without
 * importing `./spinner`. That import would close a cycle through `spinner.tsx`,
 * and Metro serves a partially initialised module for a cycle, leaving the
 * context `undefined` at import time. See AGENTS.md rule 3.
 */
export function SpinnerProvider({
	value,
	children,
}: {
	value: SpinnerContextValue;
	children: ReactNode;
}): ReactElement {
	return <SpinnerContext value={value}>{children}</SpinnerContext>;
}
SpinnerProvider.displayName = "DelacourUI.Spinner.Provider";

/** The enclosing spinner's context, or null outside a `<Spinner>`. */
export function useSpinnerContext(): SpinnerContextValue | null {
	return use(SpinnerContext);
}

/**
 * Reads the enclosing spinner's resolved colour and speed.
 *
 * Lets a custom glyph match the spinner without either being passed down to
 * it. Size is not here: the root sizes itself and everything under it fills. Throws outside a `<Spinner>` — use {@link useSpinnerContext}
 * where the enclosing spinner is optional.
 */
export function useSpinner(): SpinnerContextValue {
	const context = useSpinnerContext();
	if (!context) {
		throw new Error("useSpinner must be called inside a <Spinner>.");
	}
	return context;
}
