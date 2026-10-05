import type { ReactElement } from "react";
import { View } from "react-native";
import type { ButtonSlotProps } from "./button.types";
import { buttonVariants } from "./button.variants";

/**
 * A centred wrapper for trailing content that is not an `Icon`.
 *
 * An `Icon` needs no wrapper — it inherits the button's icon size and its
 * variant's colour from the root's `IconDefaultsProvider`.
 */
export function ButtonEndContent({ className, ...props }: ButtonSlotProps): ReactElement {
	return <View className={buttonVariants().endContent({ className })} {...props} />;
}
ButtonEndContent.displayName = "DelacourUI.Button.EndContent";
