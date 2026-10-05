import type { ReactElement, ReactNode } from "react";
import type { TextProps } from "react-native";
import { Text } from "@/components/ui/text";
import { screenVariants } from "./screen.variants";

export type ScreenNavbarSubtitleProps = Omit<TextProps, "children"> & {
	className?: string;
	children?: ReactNode;
};

/**
 * The navbar's secondary line — a step down in scale, on the muted token.
 *
 * Follows `Screen.Navbar.Title`'s rule: a string child is wrapped in a `Text`,
 * any other node passes straight through.
 */
export function ScreenNavbarSubtitle({ className, children, ...props }: ScreenNavbarSubtitleProps): ReactElement {
	if (typeof children !== "string") return <>{children}</>;

	return (
		<Text className={screenVariants().navbarSubtitle({ className })} numberOfLines={1} {...props}>
			{children}
		</Text>
	);
}
ScreenNavbarSubtitle.displayName = "DelacourUI.Screen.Navbar.Subtitle";
