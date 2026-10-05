import type { ReactElement } from "react";
import type { TextProps } from "react-native";
import { Text } from "@/components/ui/text";
import { useChipPart } from "./chip.context";
import { chipVariants } from "./chip.variants";

export type ChipLabelProps = TextProps & { className?: string };

/**
 * The chip's text.
 *
 * Reads the chip's variant, colour and selected state itself, so an
 * icon-plus-text chip changes colour on selection without the caller threading
 * anything through: a React Native `View` does not cascade colour to a `Text`
 * descendant, so a colour set on the root would be lost.
 */
export function ChipLabel({ className, ...props }: ChipLabelProps): ReactElement {
	const { variant, color, size, isSelected } = useChipPart("Chip.Label");
	return <Text className={chipVariants({ color, isSelected, size, variant }).label({ className })} {...props} />;
}
ChipLabel.displayName = "DelacourUI.Chip.Label";
