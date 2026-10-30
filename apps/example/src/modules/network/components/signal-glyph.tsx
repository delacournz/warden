import { useEffect, useRef } from "react";
import { View } from "react-native";
import Animated, {
	cancelAnimation,
	Easing,
	interpolateColor,
	useAnimatedProps,
	useSharedValue,
	withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useTones } from "@/modules/showcase/hooks/use-tones";
import type { Tone } from "@/modules/showcase/utils/tones";
import type { Sample } from "../utils/samples";
import { ARC_RADII, arcPath, BASE, litArcs } from "../utils/signal-geometry";
import { LatencyStrip } from "./latency-strip";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedLine = Animated.createAnimatedComponent(Line);

const WIDTH = 264;
const ARC_BOX = 140;
const STROKE = 9;
const EASE_OUT = Easing.out(Easing.exp);
/** The strike-through runs corner to corner of the arcs; its length drives the draw-in. */
const SLASH = { x1: 50, y1: 40, x2: 214, y2: 150 } as const;
const SLASH_LENGTH = Math.hypot(SLASH.x2 - SLASH.x1, SLASH.y2 - SLASH.y1);
const PULSE_MS = 700;
const PULSE_START = 12;
const GLYPH_STYLE = { width: WIDTH, gap: 14, marginBottom: 14 } as const;

type SignalGlyphProps = {
	/** Link quality 0..3: how many arcs are lit. */
	quality: 0 | 1 | 2 | 3;
	tone: Tone;
	/** Increments per request sent; each one sends a pulse up the arcs. */
	sent: number;
	samples: readonly Sample[];
};

/**
 * The network showcase's hero: three signal arcs over a base dot, with the latency strip beneath. Lit arcs are the
 * measured link quality; offline lights none and strikes the glyph through. Each request sent releases one pulse up
 * the arcs, which climbs only as far as the lit arcs go, so an offline link visibly goes nowhere. Colour cross-fades
 * from whatever is showing. The pulse and the strip's slide hold still under `useCalmMotion`.
 */
export function SignalGlyph({ quality, tone, sent, samples }: SignalGlyphProps) {
	const tones = useTones();
	const calm = useCalmMotion();
	const background = useThemeColor("background");
	const latest = useRef({ tones, tone });
	latest.current = { tones, tone };

	const from = useSharedValue<string>(tones[tone]);
	const to = useSharedValue<string>(tones[tone]);
	const progress = useSharedValue(1);
	const lit0 = useSharedValue(quality > 0 ? 1 : 0);
	const lit1 = useSharedValue(quality > 1 ? 1 : 0);
	const lit2 = useSharedValue(quality > 2 ? 1 : 0);
	const slash = useSharedValue(quality === 0 ? 1 : 0);
	const reach = useSharedValue<number>(ARC_RADII[Math.max(0, quality - 1)] ?? 0);
	const travel = useSharedValue(1);

	useEffect(() => {
		const next = latest.current.tones[tone];
		from.value = interpolateColor(progress.value, [0, 1], [from.value, to.value]);
		to.value = next;
		progress.value = 0;
		progress.value = withTiming(1, { duration: 420, easing: EASE_OUT });
	}, [tone, from, to, progress]);

	useEffect(() => {
		const [a, b, c] = litArcs(quality);
		lit0.value = withTiming(a ? 1 : 0, { duration: 320, easing: EASE_OUT });
		lit1.value = withTiming(b ? 1 : 0, { duration: 320, easing: EASE_OUT });
		lit2.value = withTiming(c ? 1 : 0, { duration: 320, easing: EASE_OUT });
		slash.value = withTiming(quality === 0 ? 1 : 0, { duration: 420, easing: EASE_OUT });
		reach.value = withTiming(quality === 0 ? 0 : (ARC_RADII[quality - 1] ?? 0) + 12, {
			duration: 320,
			easing: EASE_OUT,
		});
	}, [quality, lit0, lit1, lit2, slash, reach]);

	useEffect(() => {
		if (sent === 0 || calm) return;
		travel.value = 0;
		travel.value = withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.cubic) });
	}, [sent, calm, travel]);

	useEffect(
		() => () => {
			cancelAnimation(travel);
		},
		[travel]
	);

	const arc0 = useAnimatedProps(() => ({
		stroke: interpolateColor(progress.value, [0, 1], [from.value, to.value]),
		opacity: 0.16 + 0.84 * lit0.value,
	}));
	const arc1 = useAnimatedProps(() => ({
		stroke: interpolateColor(progress.value, [0, 1], [from.value, to.value]),
		opacity: 0.16 + 0.84 * lit1.value,
	}));
	const arc2 = useAnimatedProps(() => ({
		stroke: interpolateColor(progress.value, [0, 1], [from.value, to.value]),
		opacity: 0.16 + 0.84 * lit2.value,
	}));
	const arcProps = [arc0, arc1, arc2] as const;
	const baseProps = useAnimatedProps(() => ({
		fill: interpolateColor(progress.value, [0, 1], [from.value, to.value]),
	}));
	const slashProps = useAnimatedProps(() => ({
		strokeDashoffset: SLASH_LENGTH * (1 - slash.value),
		opacity: slash.value > 0 ? 1 : 0,
	}));
	const pulseProps = useAnimatedProps(() => {
		const t = travel.value;
		const fade = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
		return {
			cy: BASE.y - PULSE_START - t * reach.value,
			opacity: t >= 1 ? 0 : Math.max(0, fade),
		};
	});

	return (
		<View style={GLYPH_STYLE}>
			<Svg height={ARC_BOX} viewBox={`0 20 ${WIDTH} ${ARC_BOX}`} width={WIDTH}>
				{ARC_RADII.map((radius, i) => (
					<AnimatedPath
						animatedProps={arcProps[i]}
						d={arcPath(radius)}
						fill="none"
						key={radius}
						strokeLinecap="round"
						strokeWidth={STROKE}
					/>
				))}
				<AnimatedCircle animatedProps={baseProps} cx={BASE.x} cy={BASE.y} r={9} />
				<AnimatedCircle animatedProps={pulseProps} cx={BASE.x} fill={tones.scan} r={5} />
				<AnimatedLine
					animatedProps={slashProps}
					stroke={background}
					strokeDasharray={`${SLASH_LENGTH} ${SLASH_LENGTH}`}
					strokeLinecap="round"
					strokeWidth={STROKE + 12}
					x1={SLASH.x1}
					x2={SLASH.x2}
					y1={SLASH.y1}
					y2={SLASH.y2}
				/>
				<AnimatedLine
					animatedProps={slashProps}
					stroke={tones.off}
					strokeDasharray={`${SLASH_LENGTH} ${SLASH_LENGTH}`}
					strokeLinecap="round"
					strokeWidth={STROKE - 2}
					x1={SLASH.x1}
					x2={SLASH.x2}
					y1={SLASH.y1}
					y2={SLASH.y2}
				/>
			</Svg>
			<LatencyStrip samples={samples} tones={tones} />
		</View>
	);
}
