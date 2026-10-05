import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { PressableFeedback } from "@/components/ui/pressable/pressable.variants";
import type { ButtonGroupOrientation, ButtonGroupPosition, ButtonSize, ButtonVariant } from "./button.variants";

export type ButtonContextValue = {
	/** Size of the button. */
	size: ButtonSize;
	/** Visual variant of the button. */
	variant: ButtonVariant;
	/** Whether the button is disabled. */
	isDisabled: boolean;
	/** Whether the button has work in flight. */
	isLoading: boolean;
};

const ButtonContext = createContext<ButtonContextValue | null>(null);

/**
 * Supplies the enclosing button's variant, size and state to its subtree.
 *
 * Lives in its own module, importing nothing but `button.variants`, so a
 * component the button itself renders — `Spinner` — can read it without
 * importing `../button`. That import would close a cycle through
 * `button.tsx`, and Metro serves a partially initialised module for a cycle,
 * leaving the context `undefined` at import time.
 */
export function ButtonProvider({ value, children }: { value: ButtonContextValue; children: ReactNode }): ReactElement {
	return <ButtonContext value={value}>{children}</ButtonContext>;
}
ButtonProvider.displayName = "DelacourUI.Button.Provider";

/** The enclosing button's context, or null outside a `<Button>`. */
export function useButtonContext(): ButtonContextValue | null {
	return use(ButtonContext);
}

/**
 * Reads the enclosing button's variant, size and state.
 *
 * Lets a custom child style itself to match without the button having to pass
 * props down through every slot. Throws outside a `<Button>` — use
 * {@link useButtonContext} where the enclosing button is optional.
 */
export function useButton(): ButtonContextValue {
	const context = useButtonContext();
	if (!context) {
		throw new Error("useButton must be called inside a <Button>.");
	}
	return context;
}

/**
 * The enclosing button's context, for a compound part that cannot work without
 * one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useButton}, whose error message names the hook rather
 * than a part.
 */
export function useButtonPart(component: string): ButtonContextValue {
	const context = useButtonContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Button>.`);
	}
	return context;
}

export type ButtonGroupContextValue = {
	/** Which way the group runs. Members square the pair of corners crossing it. */
	orientation: ButtonGroupOrientation;
	/** The group owns this outright — members of different heights do not join. */
	size: ButtonSize;
	/** A default a member may override. */
	variant?: ButtonVariant;
	/** A default a member may override, so one option can disable itself. */
	isDisabled?: boolean;
	/** Press treatment for members. Unset falls back to `fade` — see `resolveButtonFeedback`. */
	feedback?: PressableFeedback;
};

export type ButtonGroupItemContextValue = ButtonGroupContextValue & {
	/** Where this member sits among the group's members, separators skipped. */
	position: ButtonGroupPosition;
	/** Overlap the member before it, so the shared edge is drawn once. */
	isSeamed: boolean;
};

const ButtonGroupContext = createContext<ButtonGroupContextValue | null>(null);

const ButtonGroupItemContext = createContext<ButtonGroupItemContextValue | null>(null);

/**
 * Supplies the enclosing group's axes to everything inside it.
 *
 * A second context beside {@link ButtonGroupItemProvider} rather than a field on
 * it, because `Button.Group.Separator` needs the orientation and is deliberately
 * *not* a member — so it has no item context to read one from.
 *
 * The optional axes are published raw. `undefined` means "the group said
 * nothing", which is what lets a member's `??` ladder see past a group that
 * named none, and what lets one member disable itself inside a group that did
 * not.
 */
export function ButtonGroupProvider({
	value,
	children,
}: {
	value: ButtonGroupContextValue;
	children: ReactNode;
}): ReactElement {
	return <ButtonGroupContext value={value}>{children}</ButtonGroupContext>;
}
ButtonGroupProvider.displayName = "DelacourUI.Button.Group.Provider";

/** The enclosing group's axes, or null outside a `<Button.Group>`. */
export function useButtonGroupContext(): ButtonGroupContextValue | null {
	return use(ButtonGroupContext);
}

/**
 * Reads the enclosing group's axes.
 *
 * Throws outside a `<Button.Group>` — use {@link useButtonGroupContext} where
 * the enclosing group is optional, as a `Button` itself does.
 */
export function useButtonGroup(): ButtonGroupContextValue {
	const context = useButtonGroupContext();
	if (!context) {
		throw new Error("useButtonGroup must be called inside a <Button.Group>.");
	}
	return context;
}

/**
 * The enclosing group's axes, for a compound part that cannot work without one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useButtonGroup}, whose error message names the hook
 * rather than a part.
 */
export function useButtonGroupPart(component: string): ButtonGroupContextValue {
	const context = useButtonGroupContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside a <Button.Group>.`);
	}
	return context;
}

/**
 * Supplies one member its place in the group.
 *
 * The group wraps each member in one of these rather than cloning props onto it.
 * A provider is not a host component, so no view is created and Yoga sees
 * exactly the children the group's own `View` already had — while a cloned prop
 * would reach only a direct child, and never one a caller wrapped in a `View` or
 * produced from a helper.
 */
export function ButtonGroupItemProvider({
	value,
	children,
}: {
	value: ButtonGroupItemContextValue;
	children: ReactNode;
}): ReactElement {
	return <ButtonGroupItemContext value={value}>{children}</ButtonGroupItemContext>;
}
ButtonGroupItemProvider.displayName = "DelacourUI.Button.Group.ItemProvider";

/** This member's place in the group, or null for a control standing on its own. */
export function useButtonGroupItemContext(): ButtonGroupItemContextValue | null {
	return use(ButtonGroupItemContext);
}

/**
 * Reads this member's place in the group.
 *
 * For a custom control that has to join a group the way a `Button` does. Throws
 * outside one — use {@link useButtonGroupItemContext} where the group is
 * optional, as the button itself does.
 */
export function useButtonGroupItem(): ButtonGroupItemContextValue {
	const context = useButtonGroupItemContext();
	if (!context) {
		throw new Error("useButtonGroupItem must be called inside a <Button.Group>.");
	}
	return context;
}
