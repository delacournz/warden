import type { ReactElement } from "react";
import { View } from "react-native";
import type { AlertSlotProps } from "./alert.types";
import { alertVariants } from "./alert.variants";

/**
 * The column holding the title, the description and any action.
 *
 * `flex-1` with `min-w-0` is what keeps a long description wrapping inside the
 * alert instead of pushing the close control off its edge.
 */
export function AlertContent({ className, ...props }: AlertSlotProps): ReactElement {
	return <View className={alertVariants().content({ className })} {...props} />;
}
AlertContent.displayName = "DelacourUI.Alert.Content";
