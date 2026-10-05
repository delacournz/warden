import type { ViewProps } from "react-native";

/**
 * The shape of a button's leading and trailing slots.
 *
 * Shared by `Button.StartContent` and `Button.EndContent`, which are identical
 * apart from where the root places them, so it lives in a leaf rather than in
 * one of the two files arbitrarily.
 */
export type ButtonSlotProps = ViewProps & { className?: string };
