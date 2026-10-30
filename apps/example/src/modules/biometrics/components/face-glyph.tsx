import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useRef } from "react";
import { View } from "react-native";
import Animated, {
	cancelAnimation,
	Easing,
	interpolateColor,
	useAnimatedProps,
	useAnimatedStyle,
	useSharedValue,
	withDelay,
	withRepeat,
	withSequence,
	withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { transparentOf } from "@/lib/color";
import type { BiometricStatus } from "../hooks/use-biometric-unlock";
import { useVaultTones } from "../hooks/use-vault-tones";
import { toneOf } from "../utils/vault-theme";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const SIZE = 208;
const BOX = SIZE + 56;
/** How much the whole glyph shrinks (and gives back its height) once the vault is open, to make room for its contents. */
const COLLAPSE = 0.42;
const STROKE = 5;
const EASE_OUT = Easing.out(Easing.exp);

/** Four corner brackets framing the face; drawn in a 200 box. */
const BRACKETS = [
	"M8 52 V30 Q8 8 30 8 H52",
	"M148 8 H170 Q192 8 192 30 V52",
	"M192 148 V170 Q192 192 170 192 H148",
	"M52 192 H30 Q8 192 8 170 V148",
] as const;
/** Eyes, nose and mouth, kept geometric so they read at any size. */
const FACE = ["M74 74 V90", "M126 74 V90", "M100 80 V114 H91", "M74 134 Q100 152 126 134"] as const;
const CHECK = "M64 102 L90 128 L138 78";
const CHECK_LENGTH = 110;
const GLOW_FILL = { flex: 1 } as const;
/** The dotted ring sits behind the frame, centred in the box. */
const RING_STYLE = { position: "absolute" } as const;

/**
 * The vault's face-frame glyph. Each state has one authored motion and then holds still, so a test runner's settle
 * wait is never held up: `Scanning` sweeps a beam for as long as the system prompt is up (that motion is the
 * behaviour), `Unlocked` closes the frame in, shrinks the glyph up out of the drawer's way, swaps the face for a drawn check and turns green, `Failed` /
 * `Cancelled` shake once in amber. Colour cross-fades from whatever is showing, never through another state's hue.
 */
export function FaceGlyph({ status }: { status: BiometricStatus }) {
	const tones = useVaultTones();
	const latestTones = useRef(tones);
	latestTones.current = tones;
	const appliedTones = useRef(tones);
	const from = useSharedValue<string>(tones[toneOf(status)]);
	const to = useSharedValue<string>(tones[toneOf(status)]);
	const tone = useSharedValue(1);
	const close = useSharedValue(0);
	const check = useSharedValue(0);
	const shake = useSharedValue(0);
	const beam = useSharedValue(0);
	const beamOpacity = useSharedValue(0);

	useEffect(() => {
		const current = latestTones.current;
		appliedTones.current = current;
		const next = current[toneOf(status)];
		from.value = interpolateColor(tone.value, [0, 1], [from.value, to.value]);
		to.value = next;
		tone.value = 0;
		tone.value = withTiming(1, { duration: 420, easing: EASE_OUT });

		const unlocked = status === "Unlocked";
		close.value = withTiming(unlocked ? 1 : 0, { duration: 620, easing: EASE_OUT });
		check.value = unlocked ? withDelay(160, withTiming(1, { duration: 520, easing: EASE_OUT })) : withTiming(0);

		if (status === "Failed" || status === "Cancelled") {
			shake.value = withSequence(
				withTiming(-14, { duration: 60 }),
				withTiming(12, { duration: 70 }),
				withTiming(-8, { duration: 70 }),
				withTiming(5, { duration: 70 }),
				withTiming(0, { duration: 90, easing: EASE_OUT })
			);
		}

		if (status === "Scanning") {
			beam.value = 0;
			beamOpacity.value = withTiming(1, { duration: 200 });
			beam.value = withRepeat(withTiming(1, { duration: 1150, easing: Easing.inOut(Easing.cubic) }), -1, true);
		} else {
			cancelAnimation(beam);
			beamOpacity.value = withTiming(0, { duration: 220 });
		}
	}, [status, from, to, tone, close, check, shake, beam, beamOpacity]);

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
	const faceProps = useAnimatedProps(() => ({
		stroke: interpolateColor(tone.value, [0, 1], [from.value, to.value]),
		opacity: 1 - check.value,
	}));
	const checkProps = useAnimatedProps(() => ({
		strokeDashoffset: CHECK_LENGTH * (1 - check.value),
	}));
	const ringProps = useAnimatedProps(() => ({
		stroke: interpolateColor(tone.value, [0, 1], [from.value, to.value]),
		opacity: 0.18 + 0.22 * close.value,
	}));
	const frameStyle = useAnimatedStyle(() => ({
		transform: [{ translateX: shake.value }, { scale: 1 - 0.1 * close.value }],
	}));
	const collapseStyle = useAnimatedStyle(() => ({ height: BOX * (1 - COLLAPSE * close.value) }));
	const shrinkStyle = useAnimatedStyle(() => ({ transform: [{ scale: 1 - COLLAPSE * close.value }] }));
	const beamStyle = useAnimatedStyle(() => ({
		opacity: beamOpacity.value,
		transform: [{ translateY: 18 + beam.value * (SIZE - 36) }],
	}));

	const glowEdge = transparentOf(tones.scan) ?? "transparent";

	return (
		<Animated.View className="w-[264px] items-center justify-center" style={collapseStyle}>
			<Animated.View className="size-[264px] items-center justify-center" style={shrinkStyle}>
				<Svg height={BOX} style={RING_STYLE} viewBox="0 0 264 264" width={BOX}>
					<AnimatedCircle
						animatedProps={ringProps}
						cx={132}
						cy={132}
						fill="none"
						r={128}
						strokeDasharray="2 7"
						strokeWidth={1.5}
					/>
				</Svg>
				<Animated.View className="size-[208px]" style={frameStyle}>
					<Svg height={SIZE} viewBox="0 0 200 200" width={SIZE}>
						{BRACKETS.map((d) => (
							<AnimatedPath
								animatedProps={stroke}
								d={d}
								fill="none"
								key={d}
								strokeLinecap="round"
								strokeWidth={STROKE}
							/>
						))}
						{FACE.map((d) => (
							<AnimatedPath
								animatedProps={faceProps}
								d={d}
								fill="none"
								key={d}
								strokeLinecap="round"
								strokeLinejoin="round"
								strokeWidth={STROKE}
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
							strokeWidth={STROKE + 2}
						/>
					</Svg>
					<Animated.View
						className="absolute inset-x-3.5 -top-3.5 h-7 justify-center"
						pointerEvents="none"
						style={beamStyle}
					>
						<View className="absolute inset-0 opacity-25">
							<LinearGradient colors={[glowEdge, tones.scan, glowEdge]} style={GLOW_FILL} />
						</View>
						<View className="h-0.5 rounded-full bg-info" />
					</Animated.View>
				</Animated.View>
			</Animated.View>
		</Animated.View>
	);
}
