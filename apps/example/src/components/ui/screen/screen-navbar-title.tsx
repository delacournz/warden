import type { ReactElement, ReactNode } from "react";
import type { TextProps } from "react-native";
import { Text } from "@/components/ui/text";
import { screenVariants } from "./screen.variants";

export type ScreenNavbarTitleProps = Omit<TextProps, "children"> & {
	className?: string;
	children?: ReactNode;
};

/**
 * The navbar's primary line.
 *
 * A string child is wrapped in a `Text`; any other node is passed straight
 * through, so a title can be an avatar row or a dropdown trigger without this
 * component second-guessing it. React Native crashes on bare text outside a
 * `<Text>`, which is why the string case cannot simply be forwarded too — the
 * same rule `Button` and `ListGroup.Item` follow.
 *
 * Carries its own colour: a `View` does not cascade one to a `Text` descendant.
 */
export function ScreenNavbarTitle({ className, children, ...props }: ScreenNavbarTitleProps): ReactElement {
	if (typeof children !== "string") return <>{children}</>;

	return (
		<Text className={screenVariants().navbarTitle({ className })} numberOfLines={1} {...props}>
			{children}
		</Text>
	);
}
ScreenNavbarTitle.displayName = "DelacourUI.Screen.Navbar.Title";
