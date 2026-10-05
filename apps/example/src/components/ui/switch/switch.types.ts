import type { ReactNode } from "react";
import type { ViewProps } from "react-native";

/**
 * Props shared by `Switch.StartContent` and `Switch.EndContent`.
 *
 * The two are the same box at opposite ends of the track — only which end, and
 * which way their opacity runs, differ — so the type lives here rather than
 * twice. `style` is `Omit`ed because both carry an animated one of their own.
 */
export type SwitchContentProps = Omit<ViewProps, "children" | "style"> & {
	className?: string;
	children?: ReactNode;
};
