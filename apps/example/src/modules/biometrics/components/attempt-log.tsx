import { StyleSheet, Text, View } from "react-native";
import Animated, { FadeInDown, LinearTransition } from "react-native-reanimated";
import type { BiometricEvent } from "../hooks/use-biometric-unlock";
import { VAULT } from "../utils/vault-theme";

/** `mm:ss.cc` since the screen opened. */
function clock(ms: number): string {
	const m = Math.floor(ms / 60_000);
	const s = (ms % 60_000) / 1000;
	return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

function describe(event: BiometricEvent): { text: string; color: string } {
	switch (event.kind) {
		case "requested":
			return { text: "face id requested", color: VAULT.scan };
		case "unlocked":
			return { text: `matched · ${event.tookMs} ms`, color: VAULT.open };
		case "cancelled":
			return { text: `prompt ${event.error}`, color: VAULT.warn };
		case "failed":
			return { text: `rejected · ${event.error}`, color: VAULT.warn };
		case "not-enrolled":
			return { text: "no face enrolled", color: VAULT.off };
		case "locked":
			return { text: "vault locked", color: VAULT.idle };
	}
}

/**
 * Newest-first log of unlock attempts, timestamped from when the screen opened. Monospace because these are
 * measurements; each new line slides in once and the rest move down.
 */
export function AttemptLog({ events, mono }: { events: readonly BiometricEvent[]; mono: string | undefined }) {
	if (events.length === 0) {
		return <Text style={[styles.empty, { fontFamily: mono }]}>no attempts yet</Text>;
	}
	return (
		<View style={styles.list}>
			{events.map((event) => {
				const { text, color } = describe(event);
				return (
					<Animated.View
						entering={FadeInDown.duration(260)}
						key={`${event.kind}-${event.at}`}
						layout={LinearTransition.duration(220)}
						style={styles.row}
					>
						<Text style={[styles.time, { fontFamily: mono }]}>{clock(event.at)}</Text>
						<View style={[styles.dot, { backgroundColor: color }]} />
						<Text numberOfLines={1} style={[styles.text, { fontFamily: mono, color }]}>
							{text}
						</Text>
					</Animated.View>
				);
			})}
		</View>
	);
}

const styles = StyleSheet.create({
	list: { gap: 10 },
	row: { flexDirection: "row", alignItems: "center", gap: 10 },
	time: { color: VAULT.faint, fontSize: 13, fontVariant: ["tabular-nums"] },
	dot: { width: 6, height: 6, borderRadius: 3 },
	text: { flex: 1, fontSize: 13 },
	empty: { color: VAULT.faint, fontSize: 13 },
});
