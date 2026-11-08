import type { ViewProps } from "react-native";

/**
 * The shape of a group's leading and trailing slots.
 *
 * Shared by `Input.Group.Prefix` and `Input.Group.Suffix`, which are identical
 * apart from where the row places them, so it lives in a leaf rather than in
 * one of the two files arbitrarily.
 */
export type InputSlotProps = ViewProps & { className?: string };

/** A group's leading or trailing slot. */
export type InputGroupDecoratorProps = InputSlotProps & {
	/**
	 * Purely visual content — an icon, a currency sign. Hidden from screen
	 * readers and transparent to touches, so a press reaches the group and
	 * focuses the field.
	 *
	 * Defaults to true when every child is bare text or an `Icon`, and to false
	 * otherwise, so a control inside stays reachable. An explicit value wins.
	 */
	isDecorative?: boolean;
};
