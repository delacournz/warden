import type { ReactElement } from "react";
import { Text, type TextPresetProps } from "@/components/ui/text";
import { useAlertPart } from "./alert.context";
import { alertVariants } from "./alert.variants";

export type AlertDescriptionProps = TextPresetProps;

/**
 * The alert's body text — always muted, whatever the status, so a long
 * explanation under a red title never shouts.
 */
export function AlertDescription({ className, ...props }: AlertDescriptionProps): ReactElement {
	const { size } = useAlertPart("Alert.Description");
	return <Text className={alertVariants({ size }).description({ className })} {...props} />;
}
AlertDescription.displayName = "DelacourUI.Alert.Description";
