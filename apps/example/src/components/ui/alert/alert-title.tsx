import type { ReactElement } from "react";
import { Text, type TextPresetProps } from "@/components/ui/text";
import { useAlertPart } from "./alert.context";
import { alertVariants } from "./alert.variants";

export type AlertTitleProps = TextPresetProps;

/**
 * The alert's heading, coloured by its status.
 *
 * The colour is the same token the indicator's glyph reads, so the two are
 * always one shade — a test pins the pair.
 */
export function AlertTitle({ className, ...props }: AlertTitleProps): ReactElement {
	const { status, size } = useAlertPart("Alert.Title");
	return <Text className={alertVariants({ size, status }).title({ className })} {...props} />;
}
AlertTitle.displayName = "DelacourUI.Alert.Title";
