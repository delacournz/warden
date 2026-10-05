import type { ViewProps } from "react-native";

/**
 * The shape of an alert's layout parts.
 *
 * Shared by `Alert.Content` and `Alert.Action`, which are both a styled `View`
 * and nothing else, so it lives in a leaf rather than in one of the two files
 * arbitrarily.
 */
export type AlertSlotProps = ViewProps & { className?: string };
