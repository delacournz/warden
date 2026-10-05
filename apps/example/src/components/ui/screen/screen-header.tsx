import type { ReactElement } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ScreenInsetProps } from "./screen.types";
import { resolveScreenEdgePadding, screenVariants } from "./screen.variants";

export type ScreenHeaderProps = ScreenInsetProps;

/**
 * A titled block at the top of a screen's content.
 *
 * Carries no gutter and no vertical padding: the scrollable it sits in already
 * has both, and a header adding its own would double them at every call site.
 * What is left is a semantic block with its own `gap-1` and optional safe-area
 * insets.
 *
 * Two nested views rather than one: the safe-area padding and anything the
 * caller adds are different concerns, and collapsing them would make
 * `insets={["top"]}` silently replace that padding instead of adding to it —
 * the failure the rest of this component was fixed for.
 *
 * Scrolls with the content — it is passed to a scrollable's `header` prop, not
 * pinned. `Screen.Navbar` is the pinned one.
 */
export function ScreenHeader({ insets, className, children, style, ...props }: ScreenHeaderProps): ReactElement {
	const safeArea = useSafeAreaInsets();

	return (
		<View style={resolveScreenEdgePadding(insets, safeArea)}>
			<View className={screenVariants().header({ className })} style={style} {...props}>
				{children}
			</View>
		</View>
	);
}
ScreenHeader.displayName = "DelacourUI.Screen.Header";
