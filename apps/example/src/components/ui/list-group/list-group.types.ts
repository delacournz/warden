import type { ReactNode } from "react";
import type { TextProps, ViewProps } from "react-native";

/**
 * The shape of a row's leading, text and trailing slots.
 *
 * Shared by `ListGroup.ItemPrefix` and `ListGroup.ItemContent`, and extended by
 * `ListGroup.ItemSuffix`, so it lives in a leaf rather than in one of them
 * arbitrarily.
 */
export type ListGroupSlotProps = ViewProps & { className?: string; children?: ReactNode };

/** The shape of a row's two text lines, `ItemTitle` and `ItemDescription`. */
export type ListGroupTextProps = TextProps & { className?: string };
