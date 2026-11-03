import { Text, View } from "react-native";
import Animated, { FadeInDown, LinearTransition } from "react-native-reanimated";
import { formatElapsed } from "../utils/elapsed";
import { TONE_CLASSES, type Tone } from "../utils/tones";

/** One log line; `at` is milliseconds since the screen opened and, with the text, keys the row. */
export type LogLine = { at: number; text: string; tone: Tone };

export type EventLogProps = {
	lines: readonly LogLine[];
	/** Shown while `lines` is empty. */
	empty: string;
	testID?: string;
};

/**
 * Newest-first event log, timestamped from when the screen opened. Monospace because these are measurements;
 * each new line slides in once and the rest move down. The tone colours the dot and the text, and the text
 * always says the state itself, so it never rests on colour alone.
 */
export function EventLog({ lines, empty, testID }: EventLogProps) {
	if (lines.length === 0) {
		return (
			<Text accessible className="font-mono text-sm text-tertiary-foreground" testID={testID}>
				{empty}
			</Text>
		);
	}
	return (
		<View className="gap-2.5" testID={testID}>
			{lines.map((line) => {
				const tone = TONE_CLASSES[line.tone];
				return (
					<Animated.View
						className="flex-row items-center gap-2.5"
						entering={FadeInDown.duration(260)}
						key={`${line.at}-${line.text}`}
						layout={LinearTransition.duration(220)}
					>
						<Text className="font-mono text-sm text-tertiary-foreground tabular-nums">{formatElapsed(line.at)}</Text>
						<View className={`size-1.5 rounded-full ${tone.dot}`} />
						<Text className={`flex-1 font-mono text-sm ${tone.text}`} numberOfLines={1}>
							{line.text}
						</Text>
					</Animated.View>
				);
			})}
		</View>
	);
}
