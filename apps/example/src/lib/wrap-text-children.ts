import { Children, type ReactElement, type ReactNode } from "react";

export type WrapTextChildrenOptions = {
	/**
	 * The children are headed for `Pressable`'s `asChild`, which merges its props
	 * into exactly one element. They come back untouched: no text is wrapped, and
	 * nothing is turned into an array, so the caller's own element takes the props.
	 */
	asChild?: boolean;
};

/**
 * Wraps bare string and number children so React Native can render them.
 *
 * React Native cannot render a string outside a `<Text>`, so a row or a pill that
 * accepts `<Item>Wi-Fi</Item>` has to wrap it. Consecutive strings and numbers
 * become one run — `Row {index}` is one piece of text, and wrapping the parts
 * separately would space them apart by the container's gap.
 *
 * Children with nothing to wrap come back as they were given when they are not
 * an array, so a single element is returned as that very element — not a
 * re-keyed copy, and never a one-item array. `Pressable` with `asChild` hands its
 * children to `Children.only`, which throws on any array, even one holding a
 * single element. When the walk does run, one resulting node is still returned
 * as that node.
 *
 * With `asChild` the children are returned untouched — see
 * {@link WrapTextChildrenOptions.asChild}.
 *
 * Free of React Native imports, so it is unit-testable.
 */
export function wrapTextChildren(
	children: ReactNode,
	wrap: (text: string, key: string) => ReactElement,
	{ asChild = false }: WrapTextChildrenOptions = {}
): ReactNode {
	if (asChild) return children;
	if (!Array.isArray(children) && typeof children !== "string" && typeof children !== "number") return children;

	const output: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		output.push(wrap(run.join(""), `content-${output.length}`));
		run = [];
	};

	for (const child of Children.toArray(children)) {
		if (typeof child === "string" || typeof child === "number") {
			run.push(child);
			continue;
		}
		flushRun();
		output.push(child);
	}
	flushRun();

	return output.length === 1 ? output[0] : output;
}
