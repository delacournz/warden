import { type ReactElement, type ReactNode, useMemo } from "react";
import { View, type ViewProps } from "react-native";
import Animated, { ZoomIn } from "react-native-reanimated";
import { IconCheckmark1Small, IconCrossSmall } from "@/lib/icons/central";
import { Icon, IconDefaultsProvider } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { Text } from "@/components/ui/text";
import { type StepsItemContextValue, useStepsItemPart } from "./steps.context";
import { resolveIndicatorForeground, resolveIndicatorGlyph, stepsVariants } from "./steps.variants";

export type StepsIndicatorChildrenProps = Pick<
	StepsItemContextValue,
	"step" | "status" | "isCurrent" | "isInvalid" | "isLoading" | "size" | "variant"
>;

export type StepsIndicatorProps = Omit<ViewProps, "children"> & {
	className?: string;
	/**
	 * Replaces what the circle draws. The circle, its size and its colours are
	 * still the step's, and an `Icon` inside inherits the glyph size and colour.
	 */
	children?: ReactNode | ((props: StepsIndicatorChildrenProps) => ReactNode);
};

/**
 * The glyph's entrance. Short and un-sprung: a check lands, it does not bounce.
 * Reduce motion is Reanimated's default `System`, which snaps it in — the state
 * is carried by the glyph's presence, not by its motion.
 */
const GLYPH_ENTERING = ZoomIn.duration(180);

/**
 * The circle: a spinner while loading, a cross while invalid, a check once
 * completed, and otherwise the step's one-based number.
 *
 * Composed in automatically, so write it out only to restyle it or to draw
 * something of your own inside the circle — an icon per step, say. Wherever it
 * is written among a step's children, the step lifts it into the track between
 * the connector halves; it never lands in the text column.
 *
 * **The circle is hidden from assistive technology.** The trigger merges its
 * children into one element, and the numeral would otherwise lead the name —
 * "2, Shipping" — restating the position the accessibility value already reads.
 *
 * **The number does not scale with the OS text size.** The circle is a fixed
 * edge, so a scaled numeral would spill out of it, and the position it shows is
 * already announced in the step's accessibility value — scaling would buy the
 * reader nothing the screen reader has not said.
 *
 * The check and cross are Central Icons and the spinner is `Spinner`; all three
 * take their size and colour from one `IconDefaultsProvider`, whose token
 * {@link resolveIndicatorForeground} keeps equal to the number's class.
 */
export function StepsIndicator({ className, children, ...props }: StepsIndicatorProps): ReactElement {
	const item = useStepsItemPart("Steps.Indicator");
	const { step, status, isCurrent, isInvalid, isLoading, isDisabled, size, variant } = item;

	const slots = stepsVariants({ isDisabled, isInvalid, size, status, variant });
	const glyphClass = slots.glyph();
	const labelClass = slots.indicatorLabel();
	const color = resolveIndicatorForeground({ isInvalid, status, variant });
	const iconDefaults = useMemo(() => ({ className: glyphClass ?? "", color }), [glyphClass, color]);

	const renderGlyph = (): ReactNode => {
		if (typeof children === "function") {
			return children({ isCurrent, isInvalid, isLoading, size, status, step, variant });
		}
		if (children) return children;

		const glyph = resolveIndicatorGlyph({ isInvalid, isLoading, status, step });
		switch (glyph.kind) {
			case "spinner":
				return <Spinner />;
			case "alert":
				return (
					<Animated.View entering={GLYPH_ENTERING} key="alert">
						<Icon icon={IconCrossSmall} />
					</Animated.View>
				);
			case "check":
				return (
					<Animated.View entering={GLYPH_ENTERING} key="check">
						<Icon icon={IconCheckmark1Small} />
					</Animated.View>
				);
			case "number":
				return (
					<Text allowFontScaling={false} className={labelClass}>
						{glyph.label}
					</Text>
				);
		}
	};

	return (
		<View
			accessibilityElementsHidden
			className={slots.indicator({ className })}
			importantForAccessibility="no-hide-descendants"
			{...props}
		>
			<IconDefaultsProvider value={iconDefaults}>{renderGlyph()}</IconDefaultsProvider>
		</View>
	);
}
StepsIndicator.displayName = "DelacourUI.Steps.Indicator";
