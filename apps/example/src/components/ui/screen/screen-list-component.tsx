import { type ComponentType, isValidElement, type ReactElement, type ReactNode } from "react";

/** What React Native's lists accept for `ListHeaderComponent` / `ListFooterComponent`. */
export type ListComponent = ComponentType<unknown> | ReactElement | null | undefined;

/**
 * Renders a list's header or footer prop as a node, whichever form it took.
 *
 * React Native accepts a component type *or* an element for these props, and a
 * Screen scrollable has to compose the caller's into its own spacers — which
 * only works with a node. Calling a component type as a function would break
 * its hooks, so it is rendered as an element instead.
 *
 * Shared by every Screen list, so it lives in a leaf of its own rather than in
 * whichever list happened to need it first.
 */
export function resolveListComponent(component: ListComponent): ReactNode {
	if (component == null) return null;
	if (isValidElement(component)) return component;

	const Component = component as ComponentType<unknown>;
	return <Component />;
}
