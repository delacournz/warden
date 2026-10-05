import { createContext, type ReactElement, type ReactNode, type RefObject, use } from "react";
import type { TextInput } from "react-native";
import type { InputSize, InputVariant } from "./input.variants";

export type InputGroupContextValue = {
	/** Visual variant of the box every part of the group sits in. */
	variant: InputVariant;
	/** Size of the box, which also drives the field's type scale and a decorator's icon. */
	size: InputSize;
	/** Whether the group reports an invalid value. */
	isInvalid: boolean;
	/** Whether the group is disabled. */
	isDisabled: boolean;
	/** Whether the field inside the group holds focus. */
	isFocused: boolean;
	/** Reported by the field on focus and blur, so the box can light up around it. */
	setFocused: (isFocused: boolean) => void;
	/**
	 * The field the group wraps, so tapping the box's gutter can focus it.
	 *
	 * A lone field is the whole tap target; inside a group the field only covers
	 * the middle of the box, and a tap on the padding either side would otherwise
	 * do nothing.
	 */
	fieldRef: RefObject<TextInput | null>;
};

const InputGroupContext = createContext<InputGroupContextValue | null>(null);

/**
 * Supplies the enclosing group's box, state and field ref to its subtree.
 *
 * The group owns the box, so it owns the axes that draw one: an `Input` inside
 * a group reads `variant`, `size`, `isInvalid` and `isDisabled` from here rather
 * than from its own props, the same way a `ListGroup.Item` takes no `variant`.
 * One box, one set of axes — two would be two things that can disagree.
 *
 * Lives in its own module, importing nothing but React and a type-only
 * `TextInput`, so `input.tsx` can read it without importing `./input-group` and
 * closing a cycle back through the root. See AGENTS.md rule 3.
 */
export function InputGroupProvider({
	value,
	children,
}: {
	value: InputGroupContextValue;
	children: ReactNode;
}): ReactElement {
	return <InputGroupContext value={value}>{children}</InputGroupContext>;
}
InputGroupProvider.displayName = "DelacourUI.Input.Group.Provider";

/** The enclosing group's context, or null for a field standing on its own. */
export function useInputGroupContext(): InputGroupContextValue | null {
	return use(InputGroupContext);
}

/**
 * Reads the enclosing `Input.Group`'s box and state.
 *
 * For a custom part that has to match the group it sits in. Throws outside one —
 * use {@link useInputGroupContext} where the group is optional, as `Input`
 * itself does.
 */
export function useInputGroup(): InputGroupContextValue {
	const context = useInputGroupContext();
	if (!context) {
		throw new Error("useInputGroup must be called inside an <Input.Group>.");
	}
	return context;
}

/**
 * The enclosing group's context, for a compound part that cannot work without
 * one.
 *
 * Internal: deliberately not re-exported from `index.ts`. A caller outside the
 * library wants {@link useInputGroup}, whose error message names the hook rather
 * than a part.
 */
export function useInputGroupPart(component: string): InputGroupContextValue {
	const context = useInputGroupContext();
	if (!context) {
		throw new Error(`${component} must be rendered inside an <Input.Group>.`);
	}
	return context;
}
