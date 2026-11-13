import { createContext, type ReactElement, type ReactNode, type RefObject, use } from "react";
import type { TextInputInstance } from "react-native";
import type { InputGroupPlacement, InputSize, InputVariant } from "./input.variants";

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
	fieldRef: RefObject<TextInputInstance | null>;
	/**
	 * Reported by the field when it is multiline, so the box can trade its fixed
	 * height for a floor and top-align the row. A `Textarea` in a group is the
	 * case this exists for.
	 */
	setMultiline: (isMultiline: boolean) => void;
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

const InputGroupPlacementContext = createContext<InputGroupPlacement | null>(null);

/**
 * Tells a part which section of the group it sits in: a row — the field's, or
 * a block's — or the box itself, between a block and the row.
 *
 * Only `Input.Group.Separator` reads it, to pick its orientation without a prop:
 * across a row it is a vertical hairline, between sections a horizontal one.
 */
export function InputGroupPlacementProvider({
	value,
	children,
}: {
	value: InputGroupPlacement;
	children: ReactNode;
}): ReactElement {
	return <InputGroupPlacementContext value={value}>{children}</InputGroupPlacementContext>;
}
InputGroupPlacementProvider.displayName = "DelacourUI.Input.Group.PlacementProvider";

/** Which section of the group a part sits in, or null outside one. */
export function useInputGroupPlacement(): InputGroupPlacement | null {
	return use(InputGroupPlacementContext);
}

const InputGroupOuterBlockContext = createContext(false);

/**
 * Tells an `Input.Group.Block` that it is the outermost one in its section —
 * the first `start` block or the last `end` block — and so sits against the
 * box's border. `Input.Group` sets it while it sorts its children.
 */
export function InputGroupOuterBlockProvider({
	value,
	children,
}: {
	value: boolean;
	children: ReactNode;
}): ReactElement {
	return <InputGroupOuterBlockContext value={value}>{children}</InputGroupOuterBlockContext>;
}
InputGroupOuterBlockProvider.displayName = "DelacourUI.Input.Group.OuterBlockProvider";

/** Whether this block is the outermost one in its section. False outside a group. */
export function useIsOuterInputGroupBlock(): boolean {
	return use(InputGroupOuterBlockContext);
}
