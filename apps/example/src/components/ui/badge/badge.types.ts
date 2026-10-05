import type { ViewProps } from "react-native";

/**
 * The shape of a badge's leading and trailing slots.
 *
 * Shared by `Badge.StartContent` and `Badge.EndContent`, which are identical
 * apart from where the root places them, so it lives in a leaf rather than in
 * one of the two files arbitrarily.
 */
export type BadgeSlotProps = ViewProps & { className?: string };
