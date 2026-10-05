import { Children, type ReactElement, type ReactNode, useMemo } from "react";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useThemeColor } from "@/hooks/use-theme-color";
import { IconDefaultsProvider } from "@/components/ui/icon";
import { Text } from "@/components/ui/text";
import { TextClassProvider } from "@/components/ui/text/text.context";
import { useSwitchPart } from "./switch.context";
import type { SwitchContentProps } from "./switch.types";
import { resolveSwitchContentTreatment, type SwitchContentPlacement, switchVariants } from "./switch.variants";

/**
 * The shared implementation behind `Switch.StartContent` and `.EndContent`.
 *
 * The two are the same box at opposite ends of the track — which end, and which
 * way their opacity runs, are the only differences — so they share this leaf
 * rather than duplicating {@link wrapTextChildren} and an animated style into
 * two part files. `Input.Group`'s two decorators make the same trade.
 *
 * **The crossfade is the component's, not the caller's.** `StartContent` sits at
 * the leading edge, which the thumb vacates as the switch turns **on**, so it
 * fades in with `progress`; `EndContent` sits at the trailing edge and fades out
 * with it. That is what lets both be written once with no conditionals — the
 * thumb reads as uncovering the other end rather than as sliding over content
 * that was always there.
 *
 * The layer is exactly the thumb's footprint at its own end, so a glyph is
 * centred on the space the knob will vacate rather than beside it.
 *
 * Not a part itself: it takes the caller-facing name so the error thrown outside
 * a switch names `Switch.StartContent` rather than something private.
 */
export function SwitchContent({
	part,
	placement,
	className,
	children,
	...props
}: SwitchContentProps & { part: string; placement: SwitchContentPlacement }): ReactElement {
	const { color, size, isDisabled, isInvalid, progress } = useSwitchPart(part);
	const slots = switchVariants({ isDisabled, size });

	const treatment = resolveSwitchContentTreatment({ color, isInvalid, placement });
	const glyphColor = useThemeColor(treatment.color);
	const glyphClassName = slots.glyph();
	const iconDefaults = useMemo(
		() => ({ className: glyphClassName, color: glyphColor ?? "" }),
		[glyphClassName, glyphColor]
	);

	const isStart = placement === "start";
	const contentStyle = useAnimatedStyle(() => ({
		opacity: isStart ? progress.value : 1 - progress.value,
	}));

	const textClassName = slots.contentText({ className: treatment.textClass });

	return (
		<Animated.View
			className={isStart ? slots.startContent({ className }) : slots.endContent({ className })}
			// Never the element a screen reader lands on. The switch announces itself
			// as one control with a checked state, and a decorative glyph either side
			// of the knob has nothing to add to that.
			accessible={false}
			importantForAccessibility="no-hide-descendants"
			pointerEvents="none"
			style={contentStyle}
			{...props}
		>
			<IconDefaultsProvider value={iconDefaults}>
				<TextClassProvider value={textClassName}>{wrapTextChildren(children)}</TextClassProvider>
			</IconDefaultsProvider>
		</Animated.View>
	);
}
SwitchContent.displayName = "DelacourUI.Switch.Content";

/**
 * Wraps bare text children in a `Text`.
 *
 * A content layer renders a `View`, and React Native cannot render a string
 * outside a `<Text>` — so `<Switch.EndContent>OFF</Switch.EndContent>`, which is
 * the shortest thing anyone will write, would otherwise crash. Consecutive
 * strings and numbers collapse into one `Text` rather than one each, the same
 * rule and the same reason as `Input`'s decorators.
 *
 * The wrapped text needs no className: the layer has already published its
 * treatment through `TextClassProvider`.
 */
function wrapTextChildren(children: ReactNode): ReactNode {
	const items = Children.toArray(children);
	const output: ReactNode[] = [];
	let run: (string | number)[] = [];

	const flushRun = () => {
		if (run.length === 0) return;
		output.push(<Text key={`content-${output.length}`}>{run.join("")}</Text>);
		run = [];
	};

	for (const child of items) {
		if (typeof child === "string" || typeof child === "number") {
			run.push(child);
			continue;
		}
		flushRun();
		output.push(child);
	}
	flushRun();

	return output;
}
