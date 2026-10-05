import type { ReactElement } from "react";
import { IconCrossSmall } from "@/lib/icons/central";
import { Icon } from "@/components/ui/icon";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { useAlertPart } from "./alert.context";
import { alertVariants } from "./alert.variants";

export type AlertCloseButtonProps = Omit<PressableProps, "asChild" | "busy" | "children">;

/**
 * The alert's trailing dismiss control.
 *
 * The root composes one in whenever `isDismissible` is set, so reach for this
 * by hand only to place it somewhere else. Pressing it calls the alert's
 * `dismiss` and then the caller's own `onPress`.
 *
 * The glyph is drawn in `muted-foreground` rather than the status colour: the
 * control is about the alert, not part of what it says, and a red cross beside
 * a red title reads as a second warning. `fade` rather than `scale` — a spring
 * on a glyph this small reads as a jitter. `hitSlop` lifts the target to the
 * 44-point minimum the glyph alone falls short of.
 */
export function AlertCloseButton({
	accessibilityLabel = "Dismiss",
	className,
	feedback = "fade",
	hitSlop = 10,
	onPress,
	...props
}: AlertCloseButtonProps): ReactElement {
	const { size, dismiss } = useAlertPart("Alert.CloseButton");

	return (
		<Pressable
			accessibilityLabel={accessibilityLabel}
			accessibilityRole="button"
			className={alertVariants({ size }).closeButton({ className })}
			feedback={feedback}
			hitSlop={hitSlop}
			onPress={() => {
				dismiss();
				onPress?.();
			}}
			{...props}
		>
			<Icon color="muted-foreground" icon={IconCrossSmall} />
		</Pressable>
	);
}
AlertCloseButton.displayName = "DelacourUI.Alert.CloseButton";
