import type { ReactElement, ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { Icon } from "@/components/ui/icon";
import { useAlertPart } from "./alert.context";
import { alertVariants } from "./alert.variants";
import { ALERT_GLYPHS } from "./alert-glyphs";

export type AlertIndicatorProps = ViewProps & {
	className?: string;
	/** Replaces the status glyph — a `Spinner`, an `Icon` of your own. It inherits the alert's icon size and colour. */
	children?: ReactNode;
};

/**
 * The alert's leading glyph, picked from its status.
 *
 * Carries the title's line height as its own height and centres the glyph in
 * it, so the glyph sits level with the title's first line however far the
 * description wraps.
 *
 * Hidden from assistive technology. The title says what happened, and a screen
 * reader announcing "image" before it adds nothing. Children replace the glyph
 * and inherit the alert's icon size and colour, so `<Spinner />` or
 * `<Icon icon={IconCloud} />` needs nothing else.
 */
export function AlertIndicator({ className, children, ...props }: AlertIndicatorProps): ReactElement {
	const { status, size } = useAlertPart("Alert.Indicator");

	return (
		<View
			accessibilityElementsHidden
			className={alertVariants({ size }).indicator({ className })}
			importantForAccessibility="no-hide-descendants"
			{...props}
		>
			{children ?? <Icon icon={ALERT_GLYPHS[status]} />}
		</View>
	);
}
AlertIndicator.displayName = "DelacourUI.Alert.Indicator";
