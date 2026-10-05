import { type ReactElement, useMemo } from "react";
import { View } from "react-native";
import { IconDefaultsProvider } from "@/components/ui/icon";
import { useEmptyStatePart } from "./empty-state.context";
import type { EmptyStateSlotProps } from "./empty-state.types";
import {
	EMPTY_STATE_MEDIA_FOREGROUND_TOKEN,
	type EmptyStateMediaVariant,
	emptyStateVariants,
} from "./empty-state.variants";

export type EmptyStateMediaProps = EmptyStateSlotProps & {
	/**
	 * `icon` draws a tinted, rounded box sized for a glyph. `default` draws
	 * nothing behind its content, for an illustration or an image that sizes
	 * itself.
	 */
	variant?: EmptyStateMediaVariant;
};

/**
 * The picture above the title.
 *
 * Its subtree inherits an icon size on the shared scale and a colour token, so a
 * bare `<Icon icon={IconInbox} />` comes out right with nothing said at the call
 * site — the same cascade a `Button` gives its icons.
 *
 * Hidden from assistive technology by default: the title already says what the
 * picture shows, and a screen reader announcing "image" first only delays it.
 * Pass `accessibilityElementsHidden={false}` and
 * `importantForAccessibility="auto"` for media that carries meaning of its own.
 */
export function EmptyStateMedia({
	variant = "default",
	className,
	children,
	...props
}: EmptyStateMediaProps): ReactElement {
	const { size } = useEmptyStatePart("EmptyState.Media");
	const slots = emptyStateVariants({ size, media: variant });
	const iconClassName = slots.mediaIcon();
	const color = EMPTY_STATE_MEDIA_FOREGROUND_TOKEN[variant];
	const iconDefaults = useMemo(() => ({ className: iconClassName, color }), [iconClassName, color]);

	return (
		<View
			accessibilityElementsHidden
			className={slots.media({ className })}
			importantForAccessibility="no-hide-descendants"
			{...props}
		>
			<IconDefaultsProvider value={iconDefaults}>{children}</IconDefaultsProvider>
		</View>
	);
}
EmptyStateMedia.displayName = "DelacourUI.EmptyState.Media";
