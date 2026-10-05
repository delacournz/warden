import type { ReactNode } from "react";
import type { TextProps, ViewProps } from "react-native";

/**
 * The shape of the header and content slots.
 *
 * Shared by `EmptyState.Header` and `EmptyState.Content`, and extended by
 * `EmptyState.Media`, so it lives in a leaf rather than in one of them
 * arbitrarily.
 */
export type EmptyStateSlotProps = ViewProps & { className?: string; children?: ReactNode };

/** The shape of the two text parts, `EmptyState.Title` and `EmptyState.Description`. */
export type EmptyStateTextProps = TextProps & { className?: string };
