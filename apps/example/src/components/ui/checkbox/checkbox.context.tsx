import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { CheckboxAlignment, CheckboxColor, CheckboxSize } from "./checkbox.variants";

export type CheckboxContextValue = {
	/** What a ticked box means. */
	color: CheckboxColor;
	/** Size of the box, its glyph and the label beside it. */
	size: CheckboxSize;
	/** Which side of the label the box sits on. */
	alignment: CheckboxAlignment;
	/** Whether the box is ticked. */
	isChecked: boolean;
	/** Whether the box reports a mixed state rather than a settled one. */
	isIndeterminate: boolean;
	/** Whether the box reports an invalid value. */
	isInvalid: boolean;
	/** Whether the box is unavailable. */
	isDisabled: boolean;
};

export type CheckboxGroupContextValue = {
	/** The `value` of every checked child. */
	checked: readonly string[];
	/** Flips one child's value in that list. */
	toggle: (value: string) => void;
	/** Defaults a child takes when it names none of its own. */
	color?: CheckboxColor;
	size?: CheckboxSize;
	alignment?: CheckboxAlignment;
	isInvalid?: boolean;
	isDisabled?: boolean;
};

const CheckboxContext = createContext<CheckboxContextValue | null>(null);

const CheckboxGroupContext = createContext<CheckboxGroupContextValue | null>(null);

/**
 * Supplies the enclosing checkbox's axes and state to its subtree.
 *
 * Lives in its own module, importing nothing but React and a type, so a part can
 * read it without importing `./checkbox`. That import would close a cycle, and
 * Metro serves a partially initialised module for a cycle — leaving the context
 * `undefined` at import time and red-boxing the app on a cold start.
 */
export function CheckboxProvider({
	value,
	children,
}: {
	value: CheckboxContextValue;
	children: ReactNode;
}): ReactElement {
	return <CheckboxContext value={value}>{children}</CheckboxContext>;
}
CheckboxProvider.displayName = "DelacourUI.Checkbox.Provider";

/** The enclosing checkbox's context, or null outside a `<Checkbox>`. */
export function useCheckboxContext(): CheckboxContextValue | null {
	return use(CheckboxContext);
}

/**
 * Reads the enclosing checkbox's axes and state.
 *
 * Lets a custom child style itself to match without the checkbox having to pass
 * props down through every slot. Throws outside a `<Checkbox>` — use
 * {@link useCheckboxContext} where the enclosing checkbox is optional.
 */
export function useCheckbox(): CheckboxContextValue {
	const context = useCheckboxContext();
	if (!context) {
		throw new Error("useCheckbox must be called inside a <Checkbox>.");
	}
	return context;
}

/**
 * The enclosing checkbox's context, for a compound part that cannot work without
 * one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useCheckbox}, whose error message names the hook rather
 * than a part.
 */
export function useCheckboxPart(component: string): CheckboxContextValue {
	const context = useCheckboxContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Checkbox>.`);
	}
	return context;
}

/**
 * Supplies the enclosing group's checked list and its shared defaults.
 *
 * A second context rather than a field on the first: a checkbox reads its group
 * to work out what it *is*, and publishes its own context describing what it
 * *became*. One value carrying both would have to exist before it could be
 * computed.
 */
export function CheckboxGroupProvider({
	value,
	children,
}: {
	value: CheckboxGroupContextValue;
	children: ReactNode;
}): ReactElement {
	return <CheckboxGroupContext value={value}>{children}</CheckboxGroupContext>;
}
CheckboxGroupProvider.displayName = "DelacourUI.Checkbox.Group.Provider";

/**
 * The enclosing group's context, or null for a checkbox standing on its own.
 *
 * This is the export the root reads. It is nullable because a checkbox has to
 * work perfectly well alone — a group is a layout and a state owner a caller
 * opts into, not a wrapper anything requires.
 */
export function useCheckboxGroupContext(): CheckboxGroupContextValue | null {
	return use(CheckboxGroupContext);
}

/**
 * Reads the enclosing group's checked list and defaults.
 *
 * For a custom control that has to sit in a group the way a `Checkbox` does.
 * Throws outside one — use {@link useCheckboxGroupContext} where the group is
 * optional, as the checkbox itself does.
 */
export function useCheckboxGroup(): CheckboxGroupContextValue {
	const context = useCheckboxGroupContext();
	if (!context) {
		throw new Error("useCheckboxGroup must be called inside a <Checkbox.Group>.");
	}
	return context;
}
