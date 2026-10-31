import { useEffect, useRef } from "react";
import { Text, View } from "react-native";
import Animated, {
	Easing,
	interpolateColor,
	useAnimatedProps,
	useAnimatedStyle,
	useSharedValue,
	withDelay,
	withSequence,
	withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { TRIAL_DAYS } from "@/modules/conditions/utils/trial";
import { useTones } from "@/modules/showcase/hooks/use-tones";
import type { Tone } from "@/modules/showcase/utils/tones";
import { type TrialState, trialLevel } from "../utils/trial-view";

const AnimatedPath = Animated.createAnimatedComponent(Path);

const BOX = 232;
const CENTER = BOX / 2;
const RADIUS = 95;
const STROKE = 16;
const SPAN = 360 / TRIAL_DAYS;
/** Degrees of empty ring between two day segments. */
const GAP = 5;
const EASE_OUT = Easing.out(Easing.exp);
/** Milliseconds between one segment starting to change and the next, so a jump reads as days passing. */
const STAGGER_MS = 55;
const SEGMENT_MS = 420;

/** The svg sits behind the numeral, centred in the box. */
const RING_STYLE = { position: "absolute" } as const;

const DAYS = Array.from({ length: TRIAL_DAYS }, (_, day) => day);

/** A point on the ring, `angle` degrees clockwise from twelve o'clock. */
function pointAt(angle: number): { x: number; y: number } {
	const rad = (angle * Math.PI) / 180;
	return { x: CENTER + RADIUS * Math.sin(rad), y: CENTER - RADIUS * Math.cos(rad) };
}

/** The arc for one day: its slice of the ring, less the gap. */
function segmentPath(day: number): string {
	const from = pointAt(day * SPAN + GAP / 2);
	const to = pointAt((day + 1) * SPAN - GAP / 2);
	return `M ${from.x} ${from.y} A ${RADIUS} ${RADIUS} 0 0 1 ${to.x} ${to.y}`;
}

const PATHS = DAYS.map(segmentPath);

/** What one day segment shows at `level` (spent days so far, `TRIAL_DAYS + 1` once expired). */
function toneOfDay(day: number, level: number): Tone {
	if (level > TRIAL_DAYS) return "warn";
	if (day < level) return "idle";
	return day === level ? "scan" : "off";
}

type SegmentProps = { path: string; tone: Tone; delayMs: number; calm: boolean };

/** One day of the ring. When its tone changes it cross-fades from whatever is showing, after `delayMs`. */
function Segment({ path, tone, delayMs, calm }: SegmentProps) {
	const tones = useTones();
	const latestTones = useRef(tones);
	latestTones.current = tones;
	const appliedTones = useRef(tones);
	const from = useSharedValue<string>(tones[tone]);
	const to = useSharedValue<string>(tones[tone]);
	const progress = useSharedValue(1);

	useEffect(() => {
		const next = latestTones.current[tone];
		if (next === to.value) return;
		from.value = interpolateColor(progress.value, [0, 1], [from.value, to.value]);
		to.value = next;
		progress.value = 0;
		progress.value = calm ? 1 : withDelay(delayMs, withTiming(1, { duration: SEGMENT_MS, easing: EASE_OUT }));
	}, [tone, delayMs, calm, from, to, progress]);

	useEffect(() => {
		if (appliedTones.current === tones) return;
		appliedTones.current = tones;
		from.value = tones[tone];
		to.value = tones[tone];
		progress.value = 1;
	}, [tones, tone, from, to, progress]);

	const animatedProps = useAnimatedProps(() => ({
		stroke: interpolateColor(progress.value, [0, 1], [from.value, to.value]),
	}));

	return <AnimatedPath animatedProps={animatedProps} d={path} fill="none" strokeWidth={STROKE} />;
}

/**
 * The trial dial: one ring segment per trial day. Spent days are ink, today's segment is blue, days to come are
 * hairlines, and an expired trial turns every segment amber. A clock jump changes the ring in one sweep, a segment at
 * a time in the direction the clock moved, then holds still. The numeral in the middle is the days left as measured,
 * never counted toward: it swaps at once and gives one small beat. The glyph is hidden from accessibility because the
 * headline and the readout say the same thing in words.
 */
export function TrialDial({ state }: { state: TrialState }) {
	const calm = useCalmMotion();
	const tones = useTones();
	const level = trialLevel(state);
	const previous = useRef(level);
	const beat = useSharedValue(1);
	const expired = state.kind === "expired";
	const days = state.kind === "active" ? state.daysLeft : 0;

	const lo = Math.min(previous.current, level);
	const hi = Math.max(previous.current, level);
	const forward = level >= previous.current;

	useEffect(() => {
		if (previous.current === level) return;
		previous.current = level;
		if (calm) return;
		beat.value = withSequence(withTiming(1.07, { duration: 110 }), withTiming(1, { duration: 360, easing: EASE_OUT }));
	}, [level, calm, beat]);

	const numeralStyle = useAnimatedStyle(() => ({ transform: [{ scale: beat.value }] }));

	return (
		<View
			accessibilityElementsHidden
			className="size-[232px] items-center justify-center"
			importantForAccessibility="no-hide-descendants"
		>
			<Svg height={BOX} style={RING_STYLE} viewBox={`0 0 ${BOX} ${BOX}`} width={BOX}>
				<Circle
					cx={CENTER}
					cy={CENTER}
					fill="none"
					r={CENTER - 4}
					stroke={tones.off}
					strokeDasharray="2 7"
					strokeOpacity={0.5}
					strokeWidth={1.5}
				/>
				{DAYS.map((day) => (
					<Segment
						calm={calm}
						delayMs={(forward ? day - lo : hi - day) * STAGGER_MS}
						key={PATHS[day]}
						path={PATHS[day] ?? ""}
						tone={toneOfDay(day, level)}
					/>
				))}
			</Svg>
			<Animated.View className="items-center" style={numeralStyle}>
				<Text className={`font-heading text-7xl leading-none ${expired ? "text-warning" : "text-foreground"}`}>
					{days}
				</Text>
				<Text className="font-mono mt-2 text-xs text-muted-foreground uppercase tracking-widest">
					{expired ? "expired" : days === 1 ? "day left" : "days left"}
				</Text>
			</Animated.View>
		</View>
	);
}
