import type { ReactElement } from "react";
import { View } from "react-native";
import type { AlertSlotProps } from "./alert.types";
import { alertVariants } from "./alert.variants";

/**
 * A wrapping row for the alert's buttons, placed under the description inside
 * `Alert.Content`.
 *
 * Takes any children — a `Button`, a `Text.Link` — and styles none of them: an
 * action is the caller's control, sized and painted the way they want it. Read
 * `useAlert().dismiss` from inside to close the alert from an action.
 */
export function AlertAction({ className, ...props }: AlertSlotProps): ReactElement {
	return <View className={alertVariants().action({ className })} {...props} />;
}
AlertAction.displayName = "DelacourUI.Alert.Action";
