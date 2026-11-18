import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import Animated, {
	cancelAnimation,
	Easing,
	interpolateColor,
	type SharedValue,
	useAnimatedProps,
	useAnimatedStyle,
	useSharedValue,
	withDelay,
	withRepeat,
	withSequence,
	withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Ellipse, Path } from "react-native-svg";
import { useCalmMotion } from "@/hooks/use-calm-motion";
import { transparentOf } from "@/lib/color";
import { useTones } from "@/modules/showcase/hooks/use-tones";
import { bittingOf, CUTS, type PasskeyStatus, toneOf } from "../utils/passkey-state";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);
const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse);

/**
 * The key is horizontal, so its frame is the vault glyph's dotted ring stretched into an ellipse around the key's band:
 * the same family, about 100 pt shorter, which keeps the call log on screen above the action.
 */
const FRAME = { width: 264, height: 152 } as const;
/** The part of the 200 drawing box the key occupies (bow, blade, deepest cut, strokes). */
const VIEW = { x: 12, y: 58, width: 178, height: 84 } as const;
const DRAWN_WIDTH = 232;
const SCALE = DRAWN_WIDTH / VIEW.width;
const DRAWN_HEIGHT = Math.round(VIEW.height * SCALE);
const STROKE = 5;
const EASE_OUT = Easing.out(Easing.exp);

/** The key, drawn in a 200 box (cropped to `VIEW`): a round bow holding a person (the passkey mark), and a blade cut along its lower edge. */
const BOW = { cx: 52, cy: 100, r: 36 } as const;
const PERSON = ["M52 81 a9 9 0 1 0 0.01 0", "M37 121 Q52 103 67 121"] as const;
const CHECK = "M37 101 L48 112 L68 90";
const CHECK_LENGTH = 46;
const BLADE_TOP = "M88 90 H184 V110";
const BLADE_Y = 110;
const TIP_X = 184;
const CUT_START = 178;
const CUT_WIDTH = 13;
const CUT_STEP = 6;
const BLADE_END = CUT_START - CUT_WIDTH * CUTS;
/** Where the scan beam travels, along the blade. */
const BEAM_FROM = (92 - VIEW.x) * SCALE - 14;
const BEAM_TO = (TIP_X - VIEW.x) * SCALE - 14;

const RING_STYLE = { position: "absolute" } as const;
const GLOW_FILL = { flex: 1 } as const;

/**
 * The blade's lower edge, right to left: each cut is a flat floor `depth` steps below the blade, joined to the next
 * by a slant, the way a key's bitting reads. `cut` (0-1) scales every depth, so 0 is the uncut blank.
 */
function bladeEdge(bitting: readonly number[], cut: number): string {
	"worklet";
	let d = `M${TIP_X} ${BLADE_Y} L${CUT_START} ${BLADE_Y}`;
	for (let i = 0; i < bitting.length; i++) {
		const x0 = CUT_START - CUT_WIDTH * i;
		const x1 = x0 - CUT_WIDTH;
		const y = BLADE_Y + (bitting[i] ?? 0) * CUT_STEP * cut;
		d += ` L${x0 - 2} ${y} L${x1 + 2} ${y}`;
	}
	return `${d} L${BLADE_END} ${BLADE_Y} L88 ${BLADE_Y}`;
}

const FAILED: ReadonlySet<PasskeyStatus> = new Set(["Cancelled", "Failed", "Rejected"]);
const BUSY: ReadonlySet<PasskeyStatus> = new Set(["Creating", "Signing in"]);

type Motion = {
	cut: (hasKey: boolean) => number;
	check: (signedIn: boolean) => number;
	shake: (shake: SharedValue<number>) => void;
	sweep: (beam: SharedValue<number>, opacity: SharedValue<number>) => void;
	hide: () => number;
};

/** The glyph's authored motions, and their calm twins (`useCalmMotion`): values land at once, no shake, no beam. */
const MOTION: Record<"full" | "calm", Motion> = {
	full: {
		cut: (hasKey) => withTiming(hasKey ? 1 : 0, { duration: hasKey ? 760 : 240, easing: EASE_OUT }),
		check: (signedIn) =>
			signedIn ? withDelay(160, withTiming(1, { duration: 520, easing: EASE_OUT })) : withTiming(0, { duration: 200 }),
		shake: (shake) => {
			shake.value = withSequence(
				withTiming(-14, { duration: 60 }),
				withTiming(12, { duration: 70 }),
				withTiming(-8, { duration: 70 }),
				withTiming(5, { duration: 70 }),
				withTiming(0, { duration: 90, easing: EASE_OUT })
			);
		},
		sweep: (beam, opacity) => {
			beam.value = 0;
			opacity.value = withTiming(1, { duration: 200 });
			beam.value = withRepeat(withTiming(1, { duration: 1050, easing: Easing.inOut(Easing.cubic) }), -1, true);
		},
		hide: () => withTiming(0, { duration: 220 }),
	},
	calm: {
		cut: (hasKey) => (hasKey ? 1 : 0),
		check: (signedIn) => (signedIn ? 1 : 0),
		shake: () => undefined,
		sweep: (beam, opacity) => {
			cancelAnimation(beam);
			opacity.value = 0;
		},
		hide: () => 0,
	},
};

/**
 * The passkeys screen's key glyph. The teeth are cut from the credential id's first bytes (`bittingOf`), so each
 * passkey cuts a different key and the shape is the real credential, not decoration. Each state has one authored
 * motion and then holds still, so a test runner's settle wait is never held up: `Creating` / `Signing in` sweep a
 * beam along the blade while the platform sheet is up, `Saved` cuts the teeth in, `Signed in` swaps the person for a
 * drawn check and turns green, `Cancelled` / `Failed` / `Rejected` shake once in amber. Under `useCalmMotion` the
 * beam and shake are skipped and the cut and check land at once. Colour cross-fades from whatever is showing.
 */
export function KeyGlyph({ status, credentialId }: { status: PasskeyStatus; credentialId: string | undefined }) {
	const tones = useTones();
	const calm = useCalmMotion();
	const latestTones = useRef(tones);
	latestTones.current = tones;
	const appliedTones = useRef(tones);
	const from = useSharedValue<string>(tones[toneOf(status)]);
	const to = useSharedValue<string>(tones[toneOf(status)]);
	const tone = useSharedValue(1);
	const cut = useSharedValue(credentialId === undefined ? 0 : 1);
	const check = useSharedValue(status === "Signed in" ? 1 : 0);
	const shake = useSharedValue(0);
	const beam = useSharedValue(0);
	const beamOpacity = useSharedValue(0);
	const bitting = bittingOf(credentialId);

	useEffect(() => {
		const next = latestTones.current[toneOf(status)];
		appliedTones.current = latestTones.current;
		from.value = interpolateColor(tone.value, [0, 1], [from.value, to.value]);
		to.value = next;
		tone.value = 0;
		tone.value = withTiming(1, { duration: calm ? 0 : 420, easing: EASE_OUT });

		const motion = MOTION[calm ? "calm" : "full"];
		const hasKey = credentialId !== undefined && status !== "Creating";
		cut.value = motion.cut(hasKey);
		check.value = motion.check(status === "Signed in");
		if (FAILED.has(status)) motion.shake(shake);
		if (BUSY.has(status)) motion.sweep(beam, beamOpacity);
		else {
			cancelAnimation(beam);
			beamOpacity.value = motion.hide();
		}
	}, [status, credentialId, calm, from, to, tone, cut, check, shake, beam, beamOpacity]);

	useEffect(() => {
		if (appliedTones.current === tones) return;
		appliedTones.current = tones;
		const now = tones[toneOf(status)];
		cancelAnimation(tone);
		from.value = now;
		to.value = now;
		tone.value = 1;
	}, [tones, status, from, to, tone]);

	const stroke = useAnimatedProps(() => ({
		stroke: interpolateColor(tone.value, [0, 1], [from.value, to.value]),
	}));
	const edgeProps = useAnimatedProps(() => ({
		d: bladeEdge(bitting, cut.value),
		stroke: interpolateColor(tone.value, [0, 1], [from.value, to.value]),
	}));
	const personProps = useAnimatedProps(() => ({
		stroke: interpolateColor(tone.value, [0, 1], [from.value, to.value]),
		opacity: 1 - check.value,
	}));
	const checkProps = useAnimatedProps(() => ({
		strokeDashoffset: CHECK_LENGTH * (1 - check.value),
	}));
	const ringProps = useAnimatedProps(() => ({
		stroke: interpolateColor(tone.value, [0, 1], [from.value, to.value]),
		opacity: 0.18 + 0.22 * check.value,
	}));
	const keyStyle = useAnimatedStyle(() => ({ transform: [{ translateX: shake.value }] }));
	const beamStyle = useAnimatedStyle(() => ({
		opacity: beamOpacity.value,
		transform: [{ translateX: BEAM_FROM + beam.value * (BEAM_TO - BEAM_FROM) }],
	}));

	const glowEdge = transparentOf(tones.scan) ?? "transparent";

	return (
		<View className="h-[152px] w-[264px] items-center justify-center">
			<Svg height={FRAME.height} style={RING_STYLE} viewBox={`0 0 ${FRAME.width} ${FRAME.height}`} width={FRAME.width}>
				<AnimatedEllipse
					animatedProps={ringProps}
					cx={FRAME.width / 2}
					cy={FRAME.height / 2}
					fill="none"
					rx={FRAME.width / 2 - 2}
					ry={FRAME.height / 2 - 2}
					strokeDasharray="2 7"
					strokeWidth={1.5}
				/>
			</Svg>
			<Animated.View className="h-[110px] w-[232px]" style={keyStyle}>
				<Svg height={DRAWN_HEIGHT} viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`} width={DRAWN_WIDTH}>
					<AnimatedCircle animatedProps={stroke} cx={BOW.cx} cy={BOW.cy} fill="none" r={BOW.r} strokeWidth={STROKE} />
					<AnimatedPath
						animatedProps={stroke}
						d={BLADE_TOP}
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={STROKE}
					/>
					<AnimatedPath
						animatedProps={edgeProps}
						fill="none"
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={STROKE}
					/>
					{PERSON.map((d) => (
						<AnimatedPath
							animatedProps={personProps}
							d={d}
							fill="none"
							key={d}
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={STROKE - 1}
						/>
					))}
					<AnimatedPath
						animatedProps={checkProps}
						d={CHECK}
						fill="none"
						stroke={tones.open}
						strokeDasharray={`${CHECK_LENGTH} ${CHECK_LENGTH}`}
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={STROKE + 1}
					/>
				</Svg>
				<Animated.View
					className="absolute top-[31px] h-[76px] w-7 flex-row justify-center"
					pointerEvents="none"
					style={beamStyle}
				>
					<View className="absolute inset-0 opacity-25">
						<LinearGradient
							colors={[glowEdge, tones.scan, glowEdge]}
							end={{ x: 1, y: 0.5 }}
							start={{ x: 0, y: 0.5 }}
							style={GLOW_FILL}
						/>
					</View>
					<View className="h-full w-0.5 rounded-full bg-info" />
				</Animated.View>
			</Animated.View>
		</View>
	);
}
