import { Children, isValidElement, type ReactElement, type ReactNode, useMemo } from "react";
import { View, type ViewProps } from "react-native";
import { Pressable } from "@/components/ui/pressable";
import { Text } from "@/components/ui/text";
import { type AvatarGroupContextValue, AvatarGroupProvider } from "./avatar.context";
import { resolveAvatarGroup, resolveAvatarOverflowLabel } from "./avatar.utils";
import { type AvatarSize, avatarVariants, resolveAvatarOverlap } from "./avatar.variants";

export type AvatarGroupProps = ViewProps & {
	/** Size for every avatar in the stack. A child's own `size` still wins. Default `md`. */
	size?: AvatarSize;
	/** How many faces to show; the rest are counted into a trailing `+N`. Caps the faces, not the row. */
	max?: number;
	/** How many people there are, when the children are only the first few of them. */
	total?: number;
	/** Points each face slides under the one before it. Default a third of the size; `0` makes a plain row. */
	overlap?: number;
	/** Makes the `+N` tile a button — to open the full list, say. */
	onOverflowPress?: () => void;
	className?: string;
	children?: ReactNode;
};

type AvatarGroupItemProps = {
	/** Position in the stack, first face first. */
	index: number;
	/** How many items the stack holds, overflow tile included. */
	count: number;
	/** The overlap, in points. */
	shift: number;
	children: ReactNode;
};

/**
 * One slot in the stack: the ring, the overlap and the stacking order.
 *
 * The ring is here rather than on the face so a face in a group is the same edge
 * as one outside it. `zIndex` counts down so the first face sits on top without
 * reversing the order a screen reader walks — the list is still read first to
 * last, in both writing directions, because the overlap is a `marginStart`.
 */
function AvatarGroupItem({ index, count, shift, children }: AvatarGroupItemProps): ReactElement {
	return (
		<View
			className={avatarVariants().groupItem()}
			role="listitem"
			style={{ marginStart: index === 0 ? 0 : -shift, zIndex: count - index }}
		>
			{children}
		</View>
	);
}
AvatarGroupItem.displayName = "DelacourUI.Avatar.Group.Item";

type AvatarGroupOverflowProps = {
	size: AvatarSize;
	overflow: number;
	onPress?: () => void;
};

/**
 * The trailing `+N` tile, the same edge as a face.
 *
 * It draws at most `99+` and reads the real number, because three digits do not
 * fit a small circle and a screen reader has room for all of them.
 */
function AvatarGroupOverflow({ size, overflow, onPress }: AvatarGroupOverflowProps): ReactElement {
	const slots = avatarVariants({ size });
	const { text, accessibilityLabel } = resolveAvatarOverflowLabel(overflow);
	const label = (
		<Text allowFontScaling={false} className={slots.overflowLabel()} numberOfLines={1}>
			{text}
		</Text>
	);

	if (onPress) {
		return (
			<Pressable
				accessibilityLabel={accessibilityLabel}
				accessibilityRole="button"
				className={slots.overflow()}
				feedback="scale"
				onPress={onPress}
			>
				{label}
			</Pressable>
		);
	}

	return (
		<View accessibilityLabel={accessibilityLabel} accessible className={slots.overflow()}>
			{label}
		</View>
	);
}
AvatarGroupOverflow.displayName = "DelacourUI.Avatar.Group.Overflow";

/**
 * A row of avatars, each overlapping the one after it, with the people who did
 * not fit counted at the end.
 *
 * Children are kept in the order they were written. `max` caps the faces and
 * `total` says how many people there really are, so three children out of forty
 * reads `+37` without forty elements in the tree.
 */
export function AvatarGroup({
	size,
	max,
	total,
	overlap,
	onOverflowPress,
	className,
	children,
	...props
}: AvatarGroupProps): ReactElement {
	const items = Children.toArray(children).filter(isValidElement);
	const { visible, overflow } = resolveAvatarGroup({ count: items.length, max, total });
	const shift = resolveAvatarOverlap({ size: size ?? "md", overlap });
	const count = visible + (overflow > 0 ? 1 : 0);
	const context = useMemo<AvatarGroupContextValue>(() => ({ size }), [size]);

	return (
		<AvatarGroupProvider value={context}>
			<View className={avatarVariants().group({ className })} role="list" {...props}>
				{items.slice(0, visible).map((child, index) => (
					<AvatarGroupItem count={count} index={index} key={child.key ?? index} shift={shift}>
						{child}
					</AvatarGroupItem>
				))}
				{overflow > 0 ? (
					<AvatarGroupItem count={count} index={visible} shift={shift}>
						<AvatarGroupOverflow onPress={onOverflowPress} overflow={overflow} size={size ?? "md"} />
					</AvatarGroupItem>
				) : null}
			</View>
		</AvatarGroupProvider>
	);
}
AvatarGroup.displayName = "DelacourUI.Avatar.Group";
