import type { ReactElement } from "react";
import { IconCrossSmall } from "@/lib/icons/central";
import { Icon } from "@/components/ui/icon";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { useBadgePart } from "./badge.context";
import { badgeVariants } from "./badge.variants";

export type BadgeCloseButtonProps = Omit<PressableProps, "asChild" | "busy" | "children" | "disabled">;

/**
 * The badge's trailing dismiss control.
 *
 * A pressable of its own rather than a mode of the root, which is what keeps a
 * dismiss from also firing the badge's `onPress`: the two gestures belong to two
 * detectors, and the inner one claims the tap.
 *
 * The root composes one in whenever `onClose` is set, so reach for this by hand
 * only to place it somewhere other than last — before an `EndContent`, say.
 *
 * The glyph is left bare: it inherits the badge's icon size and its surface's
 * colour from the root's `IconDefaultsProvider`, so a dismiss on a `destructive`
 * badge is tinted without being told.
 *
 * `fade` rather than the root's `scale` — a spring on a glyph this small reads
 * as a jitter rather than as a press.
 */
export function BadgeCloseButton({
	accessibilityLabel = "Remove",
	className,
	feedback = "fade",
	...props
}: BadgeCloseButtonProps): ReactElement {
	const { size, isDisabled } = useBadgePart("Badge.CloseButton");

	return (
		<Pressable
			accessibilityLabel={accessibilityLabel}
			accessibilityRole="button"
			className={badgeVariants({ size }).closeButton({ className })}
			disabled={isDisabled}
			feedback={feedback}
			{...props}
		>
			<Icon icon={IconCrossSmall} />
		</Pressable>
	);
}
BadgeCloseButton.displayName = "DelacourUI.Badge.CloseButton";
