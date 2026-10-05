import { createContext, type ReactElement, type ReactNode, use } from "react";

const TextClassContext = createContext<string | undefined>(undefined);

/**
 * Supplies the classes a `Text` in this subtree inherits.
 *
 * Two things publish through it, and one context rather than two is the point.
 * A `Text` publishes its own resolved class, which is what makes a nested
 * `<Text>` behave the way React Native's native text inheritance does — the
 * child adopts the parent's treatment and overrides only the axes it names. And
 * any component can publish a class of its own, which is what lets a text style
 * be *composed into* a component rather than passed as a prop: a bare `<Text>`
 * inside a `<Button>` comes out at the button's label colour and type scale
 * with nothing said at the call site.
 *
 * That is the same cascade `IconDefaultsProvider` gives icons, and deliberately
 * the same *single* path. `Spinner` once read two contexts to recompute one
 * value; see AGENTS.md rule 3.
 *
 * The value is a class string rather than an object because a `Text`'s colour
 * *is* a class — the asymmetry that forces `IconDefaults` to carry a colour
 * token alongside its className does not exist here. Its being a primitive is
 * also why nothing has to memoise it: React compares context by value, so an
 * unchanged string re-renders no consumer. That matters when every `Text` in
 * the tree renders one of these.
 *
 * `undefined` resets the cascade — wrap a subtree that must not inherit an
 * enclosing `Text`'s treatment in `<TextClassProvider value={undefined}>`.
 *
 * Lives in its own module, importing nothing but React, so a component in
 * another folder can publish into it without closing a cycle. See AGENTS.md
 * rule 3.
 */
export function TextClassProvider({
	value,
	children,
}: {
	value: string | undefined;
	children: ReactNode;
}): ReactElement {
	return <TextClassContext value={value}>{children}</TextClassContext>;
}
TextClassProvider.displayName = "DelacourUI.Text.ClassProvider";

/**
 * The classes the nearest enclosing `Text` or `TextClassProvider` published, or
 * `undefined` outside one.
 *
 * Public, so a component this library does not own can join the cascade — an
 * animated label is `<Animated.Text className={useTextClass()} style={…} />`
 * and inherits correctly with nothing else wired up.
 *
 * `undefined` rather than a `null` sentinel: there is no difference worth
 * modelling between "no provider" and "a provider with nothing to say", and
 * `cn` already treats `undefined` as an absent link in the chain.
 */
export function useTextClass(): string | undefined {
	return use(TextClassContext);
}
