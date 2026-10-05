export { Avatar, type AvatarProps } from "./avatar";
export {
	type AvatarContextValue,
	type AvatarGroupContextValue,
	AvatarProvider,
	useAvatar,
	useAvatarContext,
	useAvatarGroupContext,
} from "./avatar.context";
export {
	AVATAR_OVERFLOW_DISPLAY_MAX,
	type AvatarSource,
	type AvatarSourceEntry,
	resolveAvatarAccessibilityLabel,
	resolveAvatarGroup,
	resolveAvatarInitials,
	resolveAvatarOverflowLabel,
	resolveAvatarShowsImage,
	resolveAvatarSourceKey,
} from "./avatar.utils";
export {
	AVATAR_BADGE_PLACEMENTS,
	AVATAR_COLORS,
	AVATAR_FOREGROUND_TOKEN,
	AVATAR_SIZE_POINTS,
	AVATAR_SIZES,
	AVATAR_VARIANTS,
	type AvatarBadgePlacement,
	type AvatarColor,
	type AvatarSize,
	type AvatarVariant,
	type AvatarVariantProps,
	avatarVariants,
	resolveAvatarInteractive,
	resolveAvatarOverlap,
	resolveAvatarSize,
} from "./avatar.variants";
export type { AvatarBadgeProps } from "./avatar-badge";
export type { AvatarGroupProps } from "./avatar-group";
