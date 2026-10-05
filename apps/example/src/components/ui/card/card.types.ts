import type { ReactNode } from "react";
import type { ViewProps } from "react-native";
import type { TextPresetProps } from "@/components/ui/text";

/**
 * The shape of a card's layout parts — `Header`, `Action` and `Content`, and
 * extended by `Footer` — so it lives in a leaf rather than in one of them
 * arbitrarily.
 */
export type CardSlotProps = ViewProps & { className?: string; children?: ReactNode };

/** The shape of a card's two text parts, `Title` and `Description`. */
export type CardTextProps = TextPresetProps;
