import { createContext, type ReactElement, type ReactNode, use } from "react";
import type { FieldOrientation } from "./field.variants";

export type FieldContextValue = {
	/** Whether the field reports an invalid value. */
	isInvalid: boolean;
	/** Whether the field's control is unavailable. */
	isDisabled: boolean;
	/** Which way the field's parts are laid out. */
	orientation: FieldOrientation;
	/**
	 * A control inside offers its press here, so the whole row can drive it.
	 *
	 * The counterpart of `isInvalid` travelling the other way: state cascades
	 * down, and the one thing a control can hand back up is "tapping my label
	 * should do this". Pass `null` on unmount. A field holds one control, so a
	 * second registration replaces the first.
	 */
	registerPress: (press: (() => void) | null) => void;
	/**
	 * The text of the `Field.Label` inside, or `null` while there is none.
	 *
	 * What a control reads for its accessible name when it holds no text of its
	 * own — a `Slider.Thumb` is a capsule, and a `Switch` is a pill. React Native
	 * has no `<label for>`; this is that association, carried by the same context
	 * the state cascades down.
	 */
	label: string | null;
	/**
	 * A `Field.Label` offers its text here. Pass `null` on unmount.
	 *
	 * The counterpart of {@link FieldContextValue.registerPress} going the same
	 * way: a control hands its press up, a label hands its name down. A field
	 * holds one label, so a second registration replaces the first.
	 */
	registerLabel: (label: string | null) => void;
};

const FieldContext = createContext<FieldContextValue | null>(null);

/**
 * Supplies the enclosing field's state to its subtree.
 *
 * This is the whole reason `Field` has a context rather than a set of classes.
 * On the web, shadcn cascades a field's invalid state to its control with
 * `group-data-[invalid=true]/field:` — a parent-scoped selector. Uniwind has no
 * equivalent: its compiler reads `data-*` off a single flat selector and its
 * runtime matches them against the props of **the same component**, so a class
 * on a `Field` cannot reach the `Input` inside it. A context can.
 *
 * So `<Field isInvalid>` turns the control inside it destructive with nothing said at
 * the control, and the same channel will serve `Checkbox` and `Radio` when they
 * land. An explicit prop on the control still wins — see `Input`'s ladder.
 *
 * Lives in its own module, importing nothing but React and a type, so a
 * component in another folder can read it without importing `../field` and
 * closing a cycle. See AGENTS.md rule 3.
 *
 * **There is no `useFieldPart` here**, unlike every other compound in this
 * package, because no part of this one needs a `Field` to work. A description
 * under a `Field.Set` describes the whole set, and a label under one is a
 * section heading — both are compositions the web kit documents, and a hook that
 * threw would turn them into a red box. Every part reads
 * {@link useFieldContext} and falls back to "not invalid, not disabled", so
 * state applies where there is a field and nothing happens where there is not.
 */
export function FieldProvider({ value, children }: { value: FieldContextValue; children: ReactNode }): ReactElement {
	return <FieldContext value={value}>{children}</FieldContext>;
}
FieldProvider.displayName = "DelacourUI.Field.Provider";

/**
 * The enclosing field's state, or null outside a `<Field>`.
 *
 * This is the export a control reads. It is nullable because a control has to
 * work perfectly well on its own — a `Field` is a layout a caller opts into, not
 * a wrapper anything requires.
 */
export function useFieldContext(): FieldContextValue | null {
	return use(FieldContext);
}

/**
 * Reads the enclosing field's state.
 *
 * For a custom part that has to match the field it sits in. Throws outside one —
 * use {@link useFieldContext} where the field is optional, as every control does.
 */
export function useField(): FieldContextValue {
	const context = useFieldContext();
	if (!context) {
		throw new Error("useField must be called inside a <Field>.");
	}
	return context;
}
