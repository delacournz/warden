import { useEffect } from "react";
import { View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";
import Svg, { Circle, Line, Rect } from "react-native-svg";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { useThemeColor } from "@/hooks/use-theme-color";
import type { Tones } from "@/modules/showcase/hooks/use-tones";
import { SLOW_MS } from "../utils/link-state";
import { barHeight, type Sample, STRIP_SIZE } from "../utils/samples";

/** Width of one request's slot; the strip is `STRIP_SIZE` slots wide plus one hidden off the left edge. */
const SLOT = 11;
const BAR = 5;
const WIDTH = STRIP_SIZE * SLOT;
const HEIGHT = 60;
const BASELINE = 52;
const MAX_BAR = 44;
const CONTENT_SLOTS = STRIP_SIZE + 1;
const CLIP = { width: WIDTH, height: HEIGHT, overflow: "hidden" } as const;
const CONTENT = { position: "absolute", left: -SLOT, top: 0 } as const;

type LatencyStripProps = {
	samples: readonly Sample[];
	tones: Tones;
};

/**
 * The last 24 requests as bars: height is latency on a log scale, a failure is a warning cross on the baseline,
 * newest on the right. Each new request slides the whole strip one slot left. Empty slots are baseline dots, so
 * the strip reads as a gauge from the first frame. Slow bars (above the Slow link threshold) take the info tone.
 */
export function LatencyStrip({ samples, tones }: LatencyStripProps) {
	const calm = useCalmMotion();
	const faint = useThemeColor("border");
	const slide = useSharedValue(0);
	const newest = samples.at(-1)?.id ?? 0;

	useEffect(() => {
		if (newest === 0 || calm) return;
		slide.value = SLOT;
		slide.value = withTiming(0, { duration: 280, easing: Easing.out(Easing.cubic) });
	}, [newest, calm, slide]);

	const slideStyle = useAnimatedStyle(() => ({ transform: [{ translateX: slide.value }] }));
	const offset = CONTENT_SLOTS - samples.length;

	return (
		<View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={CLIP}>
			<Animated.View style={[CONTENT, slideStyle]}>
				<Svg height={HEIGHT} width={CONTENT_SLOTS * SLOT}>
					<Line stroke={faint} strokeWidth={1} x1={0} x2={CONTENT_SLOTS * SLOT} y1={BASELINE + 4} y2={BASELINE + 4} />
					{Array.from({ length: CONTENT_SLOTS }, (_, slot) => {
						const sample = samples[slot - offset];
						const cx = slot * SLOT + SLOT / 2;
						if (!sample) return <Circle cx={cx} cy={BASELINE} fill={faint} key={`empty-${slot}`} r={1.5} />;
						if (!sample.ok) {
							return <Cross color={tones.warn} cx={cx} cy={BASELINE - 4} key={sample.id} />;
						}
						const h = barHeight(sample.ms, MAX_BAR);
						return (
							<Rect
								fill={sample.ms > SLOW_MS ? tones.scan : tones.open}
								height={h}
								key={sample.id}
								rx={BAR / 2}
								width={BAR}
								x={cx - BAR / 2}
								y={BASELINE - h}
							/>
						);
					})}
				</Svg>
			</Animated.View>
		</View>
	);
}

/** A failed request: two short strokes crossing at (cx, cy). */
function Cross({ cx, cy, color }: { cx: number; cy: number; color: string }) {
	return (
		<>
			<Line
				stroke={color}
				strokeLinecap="round"
				strokeWidth={2.4}
				x1={cx - 3.5}
				x2={cx + 3.5}
				y1={cy - 3.5}
				y2={cy + 3.5}
			/>
			<Line
				stroke={color}
				strokeLinecap="round"
				strokeWidth={2.4}
				x1={cx - 3.5}
				x2={cx + 3.5}
				y1={cy + 3.5}
				y2={cy - 3.5}
			/>
		</>
	);
}
