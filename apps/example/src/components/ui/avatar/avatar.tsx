import { type ReactElement, type ReactNode, useMemo, useState } from "react";
import {
	Image,
	type ImageErrorEventData,
	type ImageProps,
	type ImageSourcePropType,
	type NativeSyntheticEvent,
	View,
} from "react-native";
import { IconPeople } from "@/lib/icons/central";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/ui/icon";
import { Pressable, type PressableProps } from "@/components/ui/pressable";
import { Text } from "@/components/ui/text";
import { type AvatarContextValue, AvatarProvider, useAvatarGroupContext } from "./avatar.context";
import {
	resolveAvatarAccessibilityLabel,
	resolveAvatarInitials,
	resolveAvatarShowsImage,
	resolveAvatarSourceKey,
} from "./avatar.utils";
import {
	AVATAR_FOREGROUND_TOKEN,
	type AvatarColor,
	type AvatarSize,
	type AvatarVariant,
	avatarVariants,
	resolveAvatarInteractive,
	resolveAvatarSize,
} from "./avatar.variants";
import { AvatarBadge } from "./avatar-badge";
import { AvatarGroup } from "./avatar-group";

export type AvatarProps = Omit<PressableProps, "asChild" | "busy" | "children" | "disabled"> & {
	/** The picture. The fallback shows while it loads, and in its place if it fails. */
	source?: ImageSourcePropType;
	/** The person's name. Read by screen readers, and its initials are the default fallback. */
	name?: string;
	/** Fallback text, when the initials of `name` are not what should show. */
	fallback?: string;
	/** How the fallback surface is painted. */
	variant?: AvatarVariant;
	/** What the fallback surface means. */
	color?: AvatarColor;
	/** Default `md`, or the enclosing group's size. */
	size?: AvatarSize;
	isDisabled?: boolean;
	/** Passed to the `Image`. `onError` still fires, after the fallback has taken over. */
	imageProps?: Omit<ImageProps, "source">;
	/** Overlays — an `Avatar.Badge`. */
	children?: ReactNode;
};

function AvatarRoot({
	source,
	name,
	fallback,
	variant = "soft",
	color = "default",
	size: sizeProp,
	isDisabled = false,
	imageProps,
	accessibilityLabel,
	onPress,
	onLongPress,
	haptic,
	feedback = "scale",
	pressedScale,
	pressedOpacity,
	className,
	children,
	...props
}: AvatarProps): ReactElement {
	const group = useAvatarGroupContext();
	const size = resolveAvatarSize({ size: sizeProp, groupSize: group?.size });
	const context = useMemo<AvatarContextValue>(
		() => ({ size, variant, color, isDisabled }),
		[size, variant, color, isDisabled]
	);

	// Remembered by key, not by object: an inline `source={{ uri }}` is a new
	// object every render, and a new URI has to retry on its own.
	const sourceKey = resolveAvatarSourceKey(source);
	const [failedKey, setFailedKey] = useState<string | null>(null);
	const showsImage = resolveAvatarShowsImage({ sourceKey, failedKey });
	const slots = avatarVariants({ size, variant, color, isDisabled, hasImage: showsImage });

	const initials = fallback?.trim() || resolveAvatarInitials(name);
	const label = resolveAvatarAccessibilityLabel({ accessibilityLabel, name, fallback });

	const onImageError = (event: NativeSyntheticEvent<ImageErrorEventData>) => {
		setFailedKey(sourceKey);
		imageProps?.onError?.(event);
	};

	// The fallback is always painted and the image goes over it, so the circle is
	// never empty while a picture loads or after it fails.
	const face = (
		<View className={slots.face()}>
			{initials ? (
				<Text allowFontScaling={false} className={slots.fallbackLabel()} numberOfLines={1}>
					{initials}
				</Text>
			) : (
				<Icon className={slots.icon()} color={AVATAR_FOREGROUND_TOKEN[variant][color]} icon={IconPeople} />
			)}
			{showsImage && source !== undefined ? (
				<Image
					accessibilityIgnoresInvertColors
					{...imageProps}
					className={cn(slots.image(), imageProps?.className)}
					onError={onImageError}
					source={source}
				/>
			) : null}
		</View>
	);

	if (!resolveAvatarInteractive({ onPress, onLongPress })) {
		return (
			<AvatarProvider value={context}>
				<View
					accessibilityLabel={label}
					accessibilityRole={label ? "image" : undefined}
					accessible={label !== undefined}
					className={slots.root({ className })}
					{...props}
				>
					{face}
					{children}
				</View>
			</AvatarProvider>
		);
	}

	return (
		<AvatarProvider value={context}>
			<Pressable
				accessibilityLabel={label}
				accessibilityRole="button"
				className={slots.root({ className })}
				disabled={isDisabled}
				feedback={feedback}
				haptic={haptic}
				onLongPress={onLongPress}
				onPress={onPress}
				pressedOpacity={pressedOpacity}
				pressedScale={pressedScale}
				{...props}
			>
				{face}
				{children}
			</Pressable>
		</AvatarProvider>
	);
}

/**
 * A person, as a picture — with their initials underneath for when there is no
 * picture, it is still loading, or it failed.
 *
 * **The fallback is always there.** It is painted first and the image goes on
 * top, so a slow or dead URL never leaves an empty circle. A failure is
 * remembered for that source only: change the URI or its headers and the image
 * is tried again. With no `fallback` and no `name` the fallback is a person glyph.
 *
 * `name` is what a screen reader reads, and its initials — first and last word,
 * `Mary Jane Watson` → `MW` — are the default fallback. `fallback` overrides the
 * drawn text only.
 *
 * `variant` and `color` paint the fallback surface, on the same six colours a
 * `Badge` takes. A size is a fixed edge: faces line up against each other, and a
 * circle cannot grow with OS font scaling the way a label can.
 *
 * **An avatar is content until it is given something to do.** With no `onPress`
 * or `onLongPress` it is a plain `View` announced as an image; supply either and
 * it becomes a `Pressable` announced as a button.
 *
 * Children are overlays: `Avatar.Badge` pins a count or a presence dot to a
 * corner, outside the clipped circle so it is never cut in half.
 *
 * @example
 * <Avatar name="Kate Austen" source={{ uri: user.avatarUrl }} />
 *
 * @example
 * <Avatar accessibilityLabel="Kate Austen, online" name="Kate Austen">
 *   <Avatar.Badge placement="bottom-right" />
 * </Avatar>
 *
 * @example
 * <Avatar.Group max={3} total={team.length}>
 *   {team.map((person) => <Avatar key={person.id} name={person.name} source={person.photo} />)}
 * </Avatar.Group>
 */
export const Avatar = Object.assign(AvatarRoot, {
	/** An overlay pinned to a corner — a count, or a presence dot when empty. */
	Badge: AvatarBadge,
	/** A row of overlapping avatars, with the people who did not fit counted at the end. */
	Group: AvatarGroup,
	displayName: "DelacourUI.Avatar",
});
