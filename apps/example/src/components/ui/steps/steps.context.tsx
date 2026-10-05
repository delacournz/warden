import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { StepStatus, StepsOrientation, StepsSize, StepsVariant } from "./steps.variants";

export type StepsContextValue = {
	/** The current step, zero-based. */
	value: number;
	/** How many `Steps.Item`s the root found among its direct children. `0` when it could not count them. */
	count: number;
	/** What a step calls on press. Stays quiet when the step is already current. */
	select: (step: number) => void;
	orientation: StepsOrientation;
	size: StepsSize;
	variant: StepsVariant;
	/** Steps render as plain views and take no presses. */
	isReadOnly: boolean;
	/** Steps ahead of the value cannot be pressed. */
	isLinear: boolean;
	/** Raw rather than resolved, so one step can still disable itself — see `RadioGroupContextValue`. */
	isDisabled?: boolean;
};

export type StepsItemContextValue = {
	/** This step's index, zero-based. */
	step: number;
	status: StepStatus;
	/** Whether this step is the value — true even when `completed` paints it done. */
	isCurrent: boolean;
	isInvalid: boolean;
	isLoading: boolean;
	isDisabled: boolean;
	isLast: boolean;
	orientation: StepsOrientation;
	size: StepsSize;
	variant: StepsVariant;
};

const StepsContext = createContext<StepsContextValue | null>(null);
const StepsItemContext = createContext<StepsItemContextValue | null>(null);

/**
 * Supplies the stepper's value and axes to its steps.
 *
 * Lives in its own module, importing nothing but React and types, so a part can
 * read it without importing `./steps` — which would close a cycle and leave the
 * context `undefined` on a cold start. See AGENTS.md rule 3.
 */
export function StepsProvider({ value, children }: { value: StepsContextValue; children: ReactNode }): ReactElement {
	return <StepsContext value={value}>{children}</StepsContext>;
}
StepsProvider.displayName = "DelacourUI.Steps.Provider";

/** Supplies one step's settled state to its indicator, title and description. */
export function StepsItemProvider({
	value,
	children,
}: {
	value: StepsItemContextValue;
	children: ReactNode;
}): ReactElement {
	return <StepsItemContext value={value}>{children}</StepsItemContext>;
}
StepsItemProvider.displayName = "DelacourUI.Steps.Item.Provider";

/** The enclosing stepper's context, or null outside a `<Steps>`. */
export function useStepsContext(): StepsContextValue | null {
	return use(StepsContext);
}

/**
 * Reads the enclosing stepper's value and axes.
 *
 * For a custom control — a Continue button, a progress caption — that has to
 * follow the stepper it sits beside. Throws outside one.
 */
export function useSteps(): StepsContextValue {
	const context = useStepsContext();
	if (!context) {
		throw new Error("useSteps must be called inside a <Steps>.");
	}
	return context;
}

/** The enclosing step's settled state, or null outside a `<Steps.Item>`. */
export function useStepsItemContext(): StepsItemContextValue | null {
	return use(StepsItemContext);
}

/**
 * Reads the enclosing step's settled state.
 *
 * Lets a custom child — an indicator of your own, a status badge — style itself
 * to match. Throws outside a `<Steps.Item>`.
 */
export function useStepsItem(): StepsItemContextValue {
	const context = useStepsItemContext();
	if (!context) {
		throw new Error("useStepsItem must be called inside a <Steps.Item>.");
	}
	return context;
}

/**
 * The enclosing stepper, for a part that cannot work without one.
 *
 * Internal: not re-exported from `index.ts`. A caller wants {@link useSteps},
 * whose error names the hook rather than a part.
 */
export function useStepsPart(component: string): StepsContextValue {
	const context = useStepsContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Steps>.`);
	}
	return context;
}

/** The enclosing step, for a part that cannot work without one. Internal. */
export function useStepsItemPart(component: string): StepsItemContextValue {
	const context = useStepsItemContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Steps.Item>.`);
	}
	return context;
}
