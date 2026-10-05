import type { ReactElement } from "react";
import { View } from "react-native";
import type { BadgeSlotProps } from "./badge.types";
import { badgeVariants } from "./badge.variants";

/**
 * A centred wrapper for leading content that is not an `Icon` — a status dot, an
 * avatar.
 *
 * An `Icon` needs no wrapper: it inherits the badge's icon size and its
 * surface's colour from the root's `IconDefaultsProvider`.
 */
export function BadgeStartContent({ className, ...props }: BadgeSlotProps): ReactElement {
	return <View className={badgeVariants().startContent({ className })} {...props} />;
}
BadgeStartContent.displayName = "DelacourUI.Badge.StartContent";
