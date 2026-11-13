import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useInputGroupPart } from "./input.context";
import { resolveGroupButtonClass, resolveGroupButtonSize } from "./input.variants";

export type InputGroupButtonProps = Omit<ButtonProps, "size" | "variant" | "isDisabled"> & {
	/** Default `ghost`, which sits inside the box without a fill. `secondary` suits a trailing Apply or Go. */
	variant?: "ghost" | "secondary";
};

/**
 * A `Button` sized and wired for a group — a clear, a reveal toggle, a Send.
 *
 * Its size comes from the group's, one step down so it sits inside the border
 * with room around it, and square when it holds only an icon. It is disabled
 * with the group, but does not fade on its own: the group has already faded
 * the whole box once, so a second fade would leave it darker than anything else
 * that is disabled.
 *
 * A press on it is its own — it does not focus the field the way a press on the
 * rest of the box does. Put it straight in the group's row, or inside a
 * decorator or a block.
 *
 * An icon-only button has no text for a screen reader to read, so name it with
 * `accessibilityLabel`; development builds warn when it is missing.
 *
 * @example
 * <Input.Group>
 *   <Input placeholder="Search" />
 *   <Input.Group.Button accessibilityLabel="Clear" onPress={clear}>
 *     <Icon icon={IconXmark} />
 *   </Input.Group.Button>
 * </Input.Group>
 */
export function InputGroupButton({
	variant = "ghost",
	className,
	children,
	accessibilityLabel,
	...props
}: InputGroupButtonProps): ReactElement {
	const { isDisabled, size } = useInputGroupPart("Input.Group.Button");
	const isIconOnly = isIconOnlyContent(children);

	if (process.env.NODE_ENV !== "production" && isIconOnly && !accessibilityLabel) {
		console.warn(
			"Input.Group.Button: an icon-only button needs an `accessibilityLabel`, or a screen reader announces it as an unlabelled button."
		);
	}

	return (
		<Button
			{...props}
			accessibilityLabel={accessibilityLabel}
			className={resolveGroupButtonClass({ className, isDisabled })}
			isDisabled={isDisabled}
			size={resolveGroupButtonSize(size, isIconOnly)}
			variant={variant}
		>
			{children}
		</Button>
	);
}
InputGroupButton.displayName = "DelacourUI.Input.Group.Button";

/** Whether every child is an `Icon` — the button then has no text of its own. */
function isIconOnlyContent(children: ReactNode): boolean {
	const items = Children.toArray(children);
	return items.length > 0 && items.every((child) => isValidElement(child) && child.type === Icon);
}
