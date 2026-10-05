import type { ReactElement } from "react";
import { View } from "react-native";
import type { BadgeSlotProps } from "./badge.types";
import { badgeVariants } from "./badge.variants";

/**
 * A centred wrapper for trailing content that is not an `Icon`.
 *
 * An `Icon` needs no wrapper: it inherits the badge's icon size and its
 * surface's colour from the root's `IconDefaultsProvider`.
 */
export function BadgeEndContent({ className, ...props }: BadgeSlotProps): ReactElement {
	return <View className={badgeVariants().endContent({ className })} {...props} />;
}
BadgeEndContent.displayName = "DelacourUI.Badge.EndContent";
