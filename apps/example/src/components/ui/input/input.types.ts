import type { ViewProps } from "react-native";

/**
 * The shape of a group's leading and trailing slots.
 *
 * Shared by `Input.Group.Prefix` and `Input.Group.Suffix`, which are identical
 * apart from where the row places them, so it lives in a leaf rather than in
 * one of the two files arbitrarily.
 */
export type InputSlotProps = ViewProps & { className?: string };
