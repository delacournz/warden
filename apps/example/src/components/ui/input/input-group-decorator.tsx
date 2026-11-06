import { Children, isValidElement, type ReactElement, type ReactNode, useMemo } from "react";
import { View } from "react-native";
import { Icon, IconDefaultsProvider } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { TextClassProvider } from "@/components/ui/text/text.context";
import { useInputGroupPart } from "./input.context";
import type { InputGroupDecoratorProps } from "./input.types";
import {
	INPUT_DECORATOR_ICON_TOKEN,
	INPUT_INVALID_DECORATOR_ICON_TOKEN,
	type InputDecoratorChildKind,
	inputVariants,
	resolveIsDecorative,
} from "./input.variants";

/**
 * The props a decorative decorator's view takes: out of the accessibility tree
 * on both platforms, and transparent to touches, so a press lands on the group
 * behind it and focuses the field.
 */
const DECORATIVE_VIEW_PROPS = {
	accessibilityElementsHidden: true,
	accessible: false,
	importantForAccessibility: "no-hide-descendants",
	pointerEvents: "none",
} as const;

/**
 * The shared implementation behind `Input.Group.Prefix` and `.Suffix`.
 *
 * The two are the same box in different places — the row's `gap` is what puts
 * them either side of the field, not a class of their own — so they read one
 * `decorator` slot and share this file. Duplicating {@link wrapTextChildren}
 * into two part files to keep them apart is exactly what this leaf avoids.
 *
 * A decorator holding only bare text and `Icon`s is decorative unless told
 * otherwise — see `resolveIsDecorative` — and a decorative one is hidden from
 * screen readers and lets touches through to the group.
 *
 * Not a part itself: it takes the caller-facing name so the error thrown
 * outside a group names `Input.Group.Prefix` rather than something private.
 */
export function InputGroupDecorator({
	part,
	isDecorative,
	className,
	children,
	...props
}: InputGroupDecoratorProps & { part: string }): ReactElement {
	const { isInvalid, size } = useInputGroupPart(part);
	const slots = inputVariants({ isInvalid, size });
	const decorative = resolveIsDecorative({
		explicit: isDecorative,
		kinds: Children.toArray(children).map(classifyDecoratorChild),
	});

	const iconClassName = slots.decoratorIcon();
	const iconDefaults = useMemo(
		() => ({
			className: iconClassName,
			color: isInvalid ? INPUT_INVALID_DECORATOR_ICON_TOKEN : INPUT_DECORATOR_ICON_TOKEN,
		}),
		[iconClassName, isInvalid]
	);

	return (
		<View className={slots.decorator({ className })} {...(decorative ? DECORATIVE_VIEW_PROPS : null)} {...props}>
			<IconDefaultsProvider value={iconDefaults}>
				<TextClassProvider value={slots.decoratorText()}>{wrapTextChildren(children)}</TextClassProvider>
			</IconDefaultsProvider>
		</View>
	);
}
InputGroupDecorator.displayName = "DelacourUI.Input.Group.Decorator";

/** What a decorator's child is, for deciding whether the decorator is decorative. */
function classifyDecoratorChild(child: ReactNode): InputDecoratorChildKind {
	if (typeof child === "string" || typeof child === "number") return "text";
	if (isValidElement(child) && child.type === Icon) return "icon";
	return "other";
}

/**
 * Wraps bare text children in a `Text`.
 *
 * A decorator renders a `View`, and React Native cannot render a string outside
 * a `<Text>` — so `<Input.Group.Prefix>$</Input.Group.Prefix>`, which is the
 * shortest thing anyone will write, would otherwise crash. Consecutive strings
 * and numbers are collected into one `Text` rather than one each, so a
 * `{currency}{symbol}` pair is a single affix instead of two spaced apart by
 * nothing.
 *
 * The wrapped text needs no className: the decorator has already published the
 * affix treatment through `TextClassProvider`. `Input.Group.Block` shares it
 * for the same reason.
 */
export function wrapTextChildren(children: ReactNode): ReactNode {
	const items = Children.toArray(children);
	const output: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		output.push(<Text key={`affix-${output.length}`}>{run.join("")}</Text>);
		run = [];
	};

	for (const child of items) {
		if (typeof child === "string" || typeof child === "number") {
			run.push(child);
			continue;
		}
		flushRun();
		output.push(child);
	}
	flushRun();

	return output;
}
