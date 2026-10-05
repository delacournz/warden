import type { ReactElement } from "react";
import type { TextProps } from "react-native";
import { Text } from "@/components/ui/text";
import { useBadgePart } from "./badge.context";
import { badgeVariants } from "./badge.variants";

export type BadgeLabelProps = TextProps & { className?: string };

/**
 * The badge's text.
 *
 * Carries its own colour and type scale, read from the badge's context: a React
 * Native `View` does not cascade colour to a `Text` descendant, so a colour set
 * on the root would be lost.
 *
 * The class is passed rather than inherited even though the badge publishes the
 * same one through `TextClassProvider` — the two agree, and stating it here
 * keeps the label correct if it is ever rendered somewhere the provider is not.
 */
export function BadgeLabel({ className, ...props }: BadgeLabelProps): ReactElement {
	const { variant, color, size } = useBadgePart("Badge.Label");
	return <Text className={badgeVariants({ size, variant, color }).label({ className })} {...props} />;
}
BadgeLabel.displayName = "DelacourUI.Badge.Label";
