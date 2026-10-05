import type { ReactElement } from "react";
import { interpolateColor, useAnimatedStyle } from "react-native-reanimated";
import { useThemeColor } from "@/hooks/use-theme-color";
import { Text } from "@/components/ui/text";
import { useTabsMotionPart, useTabsPart, useTabsTriggerPart } from "./tabs.context";
import type { TabsLabelProps } from "./tabs.types";
import { resolveTabSelectedness, TABS_FOREGROUND_TOKEN, TABS_LABEL_TEXT_SIZE, tabsVariants } from "./tabs.variants";

export type { TabsLabelProps };

/**
 * A trigger's text, inside the trigger's own tap target.
 *
 * Renders `Text.Label` and names a size, never a scale of its own — the weight
 * belongs to the preset, and restating it here would be a second definition of
 * `Text.Label` that could drift from it. Naming the size is what lets the label
 * still track the bar's own axis, since `Text`'s size axis is built to beat its
 * preset.
 *
 * **Its colour is an animated style, not a class, because it fades.** The label
 * interpolates between the two values `TABS_FOREGROUND_TOKEN` names, off the same
 * `position` the capsule and the panels read — so it crossfades *with* the
 * capsule arriving rather than flipping the moment the midpoint is crossed. That
 * covers a finger dragging, a flick and a plain tap without knowing which is
 * happening, because all three write the same value. `Checkbox`'s border makes
 * the same trade: a colour that travels cannot be a class, so it interpolates
 * between two tokens and the decision stays in a pure map `bun test` can sweep.
 *
 * The `label` slot therefore carries **no** colour. Two sources for one colour is
 * how a class and a style end up disagreeing for a frame on every commit.
 *
 * **`numberOfLines` defaults to one.** A label that wrapped would change the
 * row's height, which changes every measured frame, which moves the indicator —
 * so the bar would reflow around its own longest word. It is an ordinary prop, so
 * `numberOfLines={undefined}` opts out.
 */
export function TabsLabel({ className, size, numberOfLines = 1, style, ...props }: TabsLabelProps): ReactElement {
	const { size: barSize, variant } = useTabsPart("Tabs.Label");
	const { index, isDisabled } = useTabsTriggerPart("Tabs.Label");
	const { position } = useTabsMotionPart("Tabs.Label");

	// Destructured to primitives before the worklet closes over them: a fresh
	// object each render would rebuild the animated style every render.
	const tokens = TABS_FOREGROUND_TOKEN[variant];
	const unselectedColor = useThemeColor(tokens.unselected) ?? "transparent";
	const selectedColor = useThemeColor(tokens.selected) ?? "transparent";

	const colorStyle = useAnimatedStyle(() => ({
		color: interpolateColor(resolveTabSelectedness(index, position.value), [0, 1], [unselectedColor, selectedColor]),
	}));

	return (
		<Text.Label
			className={tabsVariants({ isDisabled, size: barSize, variant }).label({ className })}
			numberOfLines={numberOfLines}
			size={size ?? TABS_LABEL_TEXT_SIZE[barSize]}
			style={[colorStyle, style]}
			{...props}
		/>
	);
}
TabsLabel.displayName = "DelacourUI.Tabs.Label";
