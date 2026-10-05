import type { ReactNode } from "react";
import type { TextProps, ViewProps } from "react-native";

/**
 * The shape of an item's layout slots — `Content`, `Actions`, `Header` and
 * `Footer` — and the base `Item.Media` extends. Shared by several parts, so it
 * lives in a leaf rather than in one of them arbitrarily.
 */
export type ItemSlotProps = ViewProps & { className?: string; children?: ReactNode };

/** The shape of an item's two text lines, `Title` and `Description`. */
export type ItemTextProps = TextProps & { className?: string };
