import type { ReactElement, ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { IconCircleCheck, IconCircleInfo, IconExclamationCircle, IconExclamationTriangle } from "@/lib/icons/central";
import { Icon, type IconComponent } from "@/components/ui/icon";
import { useAlertPart } from "./alert.context";
import { type AlertStatus, alertVariants } from "./alert.variants";

/**
 * The glyph each status draws.
 *
 * `warning` and `destructive` differ in shape as well as colour — a triangle
 * against a circle — so the two stay distinguishable to anyone who cannot tell
 * amber from red. `default` shares `info`'s glyph: a neutral note is still a
 * note, and a status of its own would need a meaning it does not have.
 *
 * Lives here rather than in `alert.variants.ts` because the glyphs are React
 * Native SVG components, and that file must stay importable from `bun test`.
 */
const ALERT_GLYPHS: Record<AlertStatus, IconComponent> = {
	default: IconCircleInfo,
	info: IconCircleInfo,
	success: IconCircleCheck,
	warning: IconExclamationTriangle,
	destructive: IconExclamationCircle,
};

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
