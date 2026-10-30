import { Text, View } from "react-native";
import Animated, { FadeInDown, LinearTransition } from "react-native-reanimated";
import type { BiometricEvent } from "../hooks/use-biometric-unlock";
import { useVaultFonts } from "../hooks/use-vault-fonts";

/** `mm:ss.cc` since the screen opened. */
function clock(ms: number): string {
	const m = Math.floor(ms / 60_000);
	const s = (ms % 60_000) / 1000;
	return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** The theme colour classes for one log line: the dot and its text. `off` is a dot only, its text stays readable. */
type LineTone = { dot: string; text: string };

const SCAN: LineTone = { dot: "bg-info", text: "text-info" };
const OPEN: LineTone = { dot: "bg-success", text: "text-success" };
const WARN: LineTone = { dot: "bg-warning", text: "text-warning" };
const OFF: LineTone = { dot: "bg-off", text: "text-muted-foreground" };
const IDLE: LineTone = { dot: "bg-idle", text: "text-idle" };

function describe(event: BiometricEvent): { text: string; tone: LineTone } {
	switch (event.kind) {
		case "requested":
			return { text: "face id requested", tone: SCAN };
		case "unlocked":
			return { text: `matched · ${event.tookMs} ms`, tone: OPEN };
		case "cancelled":
			return { text: `prompt ${event.error}`, tone: WARN };
		case "failed":
			return { text: `rejected · ${event.error}`, tone: WARN };
		case "not-enrolled":
			return { text: "no face enrolled", tone: OFF };
		case "locked":
			return { text: "vault locked", tone: IDLE };
	}
}

/**
 * Newest-first log of unlock attempts, timestamped from when the screen opened. Monospace because these are
 * measurements; each new line slides in once and the rest move down.
 */
export function AttemptLog({ events }: { events: readonly BiometricEvent[] }) {
	const fonts = useVaultFonts();
	if (events.length === 0) {
		return (
			<Text className="text-[13px] text-tertiary-foreground" style={fonts.readout}>
				no attempts yet
			</Text>
		);
	}
	return (
		<View className="gap-2.5">
			{events.map((event) => {
				const { text, tone } = describe(event);
				return (
					<Animated.View
						className="flex-row items-center gap-2.5"
						entering={FadeInDown.duration(260)}
						key={`${event.kind}-${event.at}`}
						layout={LinearTransition.duration(220)}
					>
						<Text className="text-[13px] text-tertiary-foreground tabular-nums" style={fonts.readout}>
							{clock(event.at)}
						</Text>
						<View className={`size-1.5 rounded-full ${tone.dot}`} />
						<Text className={`flex-1 text-[13px] ${tone.text}`} numberOfLines={1} style={fonts.readout}>
							{text}
						</Text>
					</Animated.View>
				);
			})}
		</View>
	);
}
