import { Children, cloneElement, Fragment, isValidElement, type ReactElement, type ReactNode, type Ref } from "react";
import { composeRefs } from "./compose-refs";
import { mergeProps } from "./merge-props";

type SlotProps = {
	children?: ReactNode;
	[key: string]: unknown;
};

type ChildProps = Record<string, unknown> & { ref?: Ref<unknown> };

/**
 * Renders its props into its single child instead of emitting an element.
 *
 * This is what backs the `asChild` prop: `<Pressable asChild><Button /></Pressable>`
 * gives the Button the Pressable's behaviour with no extra View in the tree.
 * Props are combined by {@link mergeProps} and refs by {@link composeRefs}.
 *
 * React 19 exposes `ref` as an ordinary prop, so no `forwardRef` is involved.
 *
 * Do not pass a Reanimated style through this. React Native deep freezes style
 * props on a non-animated component in development, and Reanimated's effect
 * then throws trying to write to the frozen object. `Pressable` handles that
 * case by rendering the child through an animated counterpart of its own type.
 */
export function Slot({ children, ...slotProps }: SlotProps): ReactElement {
	const count = Children.count(children);

	if (count !== 1) {
		throw new Error(`Slot expects exactly one child element, received ${count}. Did you mean to omit \`asChild\`?`);
	}

	const child = Children.only(children);

	// A fragment passes `isValidElement` but drops every prop it is given, so the
	// donated handlers would never reach the element inside it.
	if (!isValidElement(child) || child.type === Fragment) {
		throw new Error("Slot expects a single React element child; text and fragments cannot receive props.");
	}

	const childProps = child.props as ChildProps;
	const merged = mergeProps<ChildProps>(slotProps, childProps);
	merged.ref = composeRefs(slotProps.ref as Ref<unknown> | undefined, childProps.ref);

	return cloneElement(child, merged);
}
Slot.displayName = "DelacourUI.Slot";
