import { useEffect, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import Animated, {
	cancelAnimation,
	Easing,
	interpolateColor,
	useAnimatedProps,
	useAnimatedStyle,
	useSharedValue,
	withRepeat,
	withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Line, Path } from "react-native-svg";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useTones } from "@/modules/showcase/hooks/use-tones";
import type { Tone } from "@/modules/showcase/utils/tones";
import { GEOFENCE_RADIUS_M, type LatLon, toLocal } from "../utils/geo";
import { fitView, scaleBar, trackPath } from "../utils/view";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** The glyph is a square this many px on a side; geometry below is in the same units. */
const SIZE = 264;
const HALF = SIZE / 2;
/** Space kept clear around the plot for the scale bar and north tick. */
const PAD = 30;
const PLOT_HALF = HALF - PAD;
const BAR_MAX_PX = 96;
const EASE_OUT = Easing.out(Easing.exp);
const FIT_MS = 520;
const PULSE_MS = 2200;
const DOT_R = 6;
const START_R = 4;

type TrackGlyphProps = {
	track: readonly LatLon[];
	/** Geofence centre and track start; null before the first fix. */
	origin: LatLon | null;
	/** The tone of the geofence ring and, with the headline, of the state. */
	ringTone: Tone;
};

/**
 * The live track, drawn from the fixes actually received on a local equirectangular projection (no map tiles: the
 * geometry is the data). The view re-fits as the track grows, easing to the new scale; the track runs on the UI thread
 * so its end follows the dot while the view moves. The 150 m geofence is the dashed ring around the first fix and takes
 * the state's tone; the scale bar is the true length of its label at the current scale; north is up.
 */
export function TrackGlyph({ track, origin, ringTone }: TrackGlyphProps) {
	const tones = useTones();
	const background = useThemeColor("background");
	const faint = useThemeColor("tertiary-foreground");
	const calm = useCalmMotion();
	const latestTones = useRef(tones);
	latestTones.current = tones;
	const appliedTones = useRef(tones);

	const flat = useMemo(() => {
		if (!origin) return [] as number[];
		const out: number[] = [];
		for (const p of track) {
			const { x, y } = toLocal(origin, p);
			out.push(x, y);
		}
		return out;
	}, [track, origin]);

	const target = useMemo(() => {
		const points = [];
		for (let i = 0; i < flat.length; i += 2) points.push({ x: flat[i], y: flat[i + 1] });
		return fitView(points, GEOFENCE_RADIUS_M, PLOT_HALF);
	}, [flat]);
	const bar = useMemo(() => scaleBar(target.scale, BAR_MAX_PX), [target.scale]);

	const points = useSharedValue<number[]>(flat);
	const scale = useSharedValue(target.scale);
	const cx = useSharedValue(target.cx);
	const cy = useSharedValue(target.cy);
	const hasFix = useSharedValue(flat.length > 0 ? 1 : 0);
	const pulse = useSharedValue(0);
	const from = useSharedValue<string>(tones[ringTone]);
	const to = useSharedValue<string>(tones[ringTone]);
	const tone = useSharedValue(1);

	useEffect(() => {
		points.value = flat;
		hasFix.value = withTiming(flat.length > 0 ? 1 : 0, { duration: 260 });
		scale.value = withTiming(target.scale, { duration: FIT_MS, easing: EASE_OUT });
		cx.value = withTiming(target.cx, { duration: FIT_MS, easing: EASE_OUT });
		cy.value = withTiming(target.cy, { duration: FIT_MS, easing: EASE_OUT });
	}, [flat, target, points, hasFix, scale, cx, cy]);

	useEffect(() => {
		appliedTones.current = latestTones.current;
		from.value = interpolateColor(tone.value, [0, 1], [from.value, to.value]);
		to.value = latestTones.current[ringTone];
		tone.value = 0;
		tone.value = withTiming(1, { duration: 420, easing: EASE_OUT });
	}, [ringTone, from, to, tone]);

	useEffect(() => {
		if (appliedTones.current === tones) return;
		appliedTones.current = tones;
		const now = tones[ringTone];
		cancelAnimation(tone);
		from.value = now;
		to.value = now;
		tone.value = 1;
	}, [tones, ringTone, from, to, tone]);

	const isLive = flat.length > 0;
	useEffect(() => {
		cancelAnimation(pulse);
		pulse.value = 0;
		if (isLive && !calm) {
			pulse.value = withRepeat(withTiming(1, { duration: PULSE_MS, easing: Easing.out(Easing.quad) }), -1, false);
		}
	}, [isLive, calm, pulse]);

	const lineProps = useAnimatedProps(() => ({
		d: trackPath(points.value, { scale: scale.value, cx: cx.value, cy: cy.value }, HALF),
	}));
	const ringProps = useAnimatedProps(() => ({
		cx: HALF - cx.value * scale.value,
		cy: HALF + cy.value * scale.value,
		r: GEOFENCE_RADIUS_M * scale.value,
		stroke: interpolateColor(tone.value, [0, 1], [from.value, to.value]),
		opacity: 0.55 + 0.45 * hasFix.value,
	}));
	const startProps = useAnimatedProps(() => ({
		cx: HALF - cx.value * scale.value,
		cy: HALF + cy.value * scale.value,
		opacity: hasFix.value,
	}));
	const dotProps = useAnimatedProps(() => {
		const n = points.value.length;
		return {
			cx: n >= 2 ? HALF + (points.value[n - 2] - cx.value) * scale.value : HALF,
			cy: n >= 2 ? HALF - (points.value[n - 1] - cy.value) * scale.value : HALF,
			opacity: hasFix.value,
		};
	});
	const pulseProps = useAnimatedProps(() => {
		const n = points.value.length;
		return {
			cx: n >= 2 ? HALF + (points.value[n - 2] - cx.value) * scale.value : HALF,
			cy: n >= 2 ? HALF - (points.value[n - 1] - cy.value) * scale.value : HALF,
			r: DOT_R + 14 * pulse.value,
			opacity: 0.5 * (1 - pulse.value) * hasFix.value,
		};
	});
	const barStyle = useAnimatedStyle(() => ({ width: bar.meters * scale.value }));

	return (
		<View className="items-center justify-center" style={{ width: SIZE, height: SIZE }}>
			<Svg height={SIZE} style={{ position: "absolute" }} viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE}>
				<Circle
					cx={HALF}
					cy={HALF}
					fill="none"
					opacity={0.22}
					r={HALF - 4}
					stroke={tones.idle}
					strokeDasharray="2 7"
					strokeWidth={1.5}
				/>
				<AnimatedCircle
					animatedProps={ringProps}
					fill="none"
					strokeDasharray="6 6"
					strokeLinecap="round"
					strokeWidth={2}
				/>
				<AnimatedPath
					animatedProps={lineProps}
					fill="none"
					stroke={tones.scan}
					strokeLinecap="round"
					strokeLinejoin="round"
					strokeWidth={3}
				/>
				<AnimatedCircle animatedProps={startProps} fill={background} r={START_R} stroke={tones.scan} strokeWidth={2} />
				<AnimatedCircle animatedProps={pulseProps} fill="none" stroke={tones.scan} strokeWidth={2} />
				<AnimatedCircle animatedProps={dotProps} fill={tones.scan} r={DOT_R} stroke={background} strokeWidth={2.5} />
				<Line stroke={faint} strokeLinecap="round" strokeWidth={1.5} x1={SIZE - PAD} x2={SIZE - PAD} y1={34} y2={20} />
				<Line
					stroke={faint}
					strokeLinecap="round"
					strokeWidth={1.5}
					x1={SIZE - PAD}
					x2={SIZE - PAD - 3}
					y1={20}
					y2={24}
				/>
				<Line
					stroke={faint}
					strokeLinecap="round"
					strokeWidth={1.5}
					x1={SIZE - PAD}
					x2={SIZE - PAD + 3}
					y1={20}
					y2={24}
				/>
			</Svg>
			<Text className="absolute font-mono text-tertiary-foreground text-xs" style={{ right: PAD - 4, top: 34 }}>
				N
			</Text>
			<View className="absolute flex-row items-center gap-2" style={{ left: PAD, bottom: 14 }}>
				<Animated.View className="h-1.5 border-x border-b border-tertiary-foreground" style={barStyle} />
				<Text className="font-mono text-tertiary-foreground text-xs">{bar.label}</Text>
			</View>
		</View>
	);
}
