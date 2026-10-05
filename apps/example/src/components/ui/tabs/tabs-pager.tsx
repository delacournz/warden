import { type ReactElement, type ReactNode, useCallback } from "react";
import type { LayoutChangeEvent } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useTabsMotionPart, useTabsPart } from "./tabs.context";
import { resolvePagerTranslate, tabsVariants } from "./tabs.variants";

export type TabsPagerProps = {
	children: ReactNode;
};

/**
 * The clipped viewport the panels travel through, and the surface the pan is
 * claimed on.
 *
 * Internal: the root wraps its own run of `Tabs.Content` children in one of these,
 * so there is no key for it on the compound surface and nothing for a caller to
 * configure that `isSwipeable` does not already decide — `Checkbox.Indicator`'s
 * argument. It has a file of its own because it owns every animated value on the
 * panel side, and keeping those in the root would make the root a component that
 * changes for two unrelated reasons.
 *
 * **The row needs no measurement to lay out.** Each page is `w-full shrink-0`
 * against a row whose width is the viewport's, so the very first paint is right.
 * A row sized from a measurement would land one commit after the first layout and
 * show every panel collapsed to nothing in between — the same class of bug as a
 * chat list with no seeded composer height, wrong only sometimes.
 *
 * `pageWidth` is therefore read by the gesture and by the translation, and by
 * nothing that lays anything out.
 */
export function TabsPager({ children }: TabsPagerProps): ReactElement {
	const { size, variant } = useTabsPart("Tabs.Pager");
	const { position, pageWidth, panGesture } = useTabsMotionPart("Tabs.Pager");

	const handleLayout = useCallback(
		(event: LayoutChangeEvent) => {
			pageWidth.value = event.nativeEvent.layout.width;
		},
		[pageWidth]
	);

	const rowStyle = useAnimatedStyle(() => ({
		transform: [{ translateX: resolvePagerTranslate(position.value, pageWidth.value) }],
	}));

	const slots = tabsVariants({ size, variant });

	return (
		<Animated.View className={slots.pager()} onLayout={handleLayout}>
			<GestureDetector gesture={panGesture}>
				<Animated.View className={slots.pageRow()} style={rowStyle}>
					{children}
				</Animated.View>
			</GestureDetector>
		</Animated.View>
	);
}
TabsPager.displayName = "DelacourUI.Tabs.Pager";
