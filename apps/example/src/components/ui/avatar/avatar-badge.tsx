import type { ReactElement, ReactNode } from "react";
import { View, type ViewProps } from "react-native";
import { cn } from "@/lib/cn";
import { useAvatarPart } from "./avatar.context";
import { type AvatarBadgePlacement, type AvatarColor, avatarVariants } from "./avatar.variants";

export type AvatarBadgeProps = ViewProps & {
	/** Which corner the overlay is pinned to. Default `top-right`. */
	placement?: AvatarBadgePlacement;
	/** The presence dot's colour, when there are no children. Default `success`. */
	color?: AvatarColor;
	className?: string;
	/** What to pin — a `Badge` with a count, an `Icon`. Leave empty for a presence dot. */
	children?: ReactNode;
};

/**
 * An overlay pinned to a corner of the avatar — an unread count, a presence dot.
 *
 * **Empty, it is a presence dot** sized to the face it sits on and ringed in the
 * page background, so it reads as separate from the photo underneath. Given
 * children, it is only the pin: a `Badge` or an `Icon` dropped in keeps its own
 * look, which is what lets a count and a dot share one part.
 *
 * It sits in the avatar's unclipped root, never inside the circle, so it can
 * hang over the edge without being cut in half.
 *
 * A dot says nothing to a screen reader on its own: the avatar is one element to
 * assistive technology, so put the status into its `accessibilityLabel`.
 */
export function AvatarBadge({
	placement = "top-right",
	color = "success",
	className,
	children,
	...props
}: AvatarBadgeProps): ReactElement {
	const { size } = useAvatarPart("Avatar.Badge");
	const slots = avatarVariants({ size, placement, color });

	if (children === undefined || children === null || children === false) {
		return <View className={cn(slots.badge(), slots.dot(), className)} pointerEvents="none" {...props} />;
	}

	return (
		<View className={slots.badge({ className })} pointerEvents="box-none" {...props}>
			{children}
		</View>
	);
}
AvatarBadge.displayName = "DelacourUI.Avatar.Badge";
