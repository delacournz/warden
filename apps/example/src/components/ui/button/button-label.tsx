import type { ReactElement } from "react";
import type { TextProps } from "react-native";
import { Text } from "@/components/ui/text";
import { useButtonPart } from "./button.context";
import { buttonVariants } from "./button.variants";

export type ButtonLabelProps = TextProps & { className?: string };

/**
 * The button's text.
 *
 * Carries its own colour and type scale, read from the button's context: a
 * React Native `View` does not cascade colour to a `Text` descendant, so a
 * colour set on the root would be lost.
 *
 * The class is passed rather than inherited even though the button publishes the
 * same one through `TextClassProvider` — the two agree, and stating it here
 * keeps the label correct if it is ever rendered somewhere the provider is not.
 */
export function ButtonLabel({ className, ...props }: ButtonLabelProps): ReactElement {
	const { variant, size } = useButtonPart("Button.Label");
	return <Text className={buttonVariants({ size, variant }).label({ className })} {...props} />;
}
ButtonLabel.displayName = "DelacourUI.Button.Label";
