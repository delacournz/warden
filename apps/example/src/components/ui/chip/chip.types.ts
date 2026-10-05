import type { ViewProps } from "react-native";

/**
 * The shape of a chip's leading and trailing slots.
 *
 * Shared by `Chip.StartContent` and `Chip.EndContent`, which are identical apart
 * from where the root places them, so it lives in a leaf rather than in one of
 * the two files arbitrarily.
 */
export type ChipSlotProps = ViewProps & { className?: string };
