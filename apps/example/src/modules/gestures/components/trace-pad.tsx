import type { ReactElement } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { Text } from "@/components/ui/text";
import type { TraceCommit } from "../hooks/use-gesture-readout";

type TracePadProps = {
	onCommit: (next: TraceCommit) => void;
};

const PAD_HEIGHT = 120;

/**
 * Target for one-finger path gestures. A 1-pointer Pan (`minDistance(1)` so the first points are not swallowed by the
 * default activation slop) adds up the length of every segment between pan updates, across strokes, and remembers
 * where the last stroke ended. On `onEnd` it commits the cumulative length and the end position to React state
 * through `scheduleOnRN`; the readout turns them into fractions of the pad. The pad is `accessible` so its testID is
 * in the accessibility tree.
 */
export function TracePad({ onCommit }: TracePadProps): ReactElement {
	const width = useSharedValue(0);
	const height = useSharedValue(PAD_HEIGHT);
	const lastX = useSharedValue(0);
	const lastY = useSharedValue(0);
	const length = useSharedValue(0);

	const pan = Gesture.Pan()
		.maxPointers(1)
		.minDistance(1)
		.onBegin((e) => {
			lastX.set(e.x);
			lastY.set(e.y);
		})
		.onUpdate((e) => {
			length.set(length.get() + Math.hypot(e.x - lastX.get(), e.y - lastY.get()));
			lastX.set(e.x);
			lastY.set(e.y);
		})
		.onEnd(() => {
			scheduleOnRN(onCommit, {
				length: length.get(),
				endX: lastX.get(),
				endY: lastY.get(),
				size: { width: width.get(), height: height.get() },
			});
		});

	return (
		<GestureDetector gesture={pan}>
			<View
				accessibilityLabel="Trace pad"
				accessible
				className="w-full items-center justify-center rounded-2xl bg-muted"
				onLayout={(e) => {
					width.set(e.nativeEvent.layout.width);
					height.set(e.nativeEvent.layout.height);
				}}
				style={{ height: PAD_HEIGHT }}
				testID="gestures-trace"
			>
				<Text.Caption color="muted">Trace pad</Text.Caption>
			</View>
		</GestureDetector>
	);
}
