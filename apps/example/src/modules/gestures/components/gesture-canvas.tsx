import type { ReactElement } from "react";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import type { TransformCommit } from "../hooks/use-gesture-readout";

type GestureCanvasProps = {
	onCommit: (next: TransformCommit) => void;
	onPointers: (count: number) => void;
};

const CANVAS_HEIGHT = 300;
const SQUARE = 120;

/**
 * Target for pinch, two-finger rotate and two-finger pan. Pinch, Rotation and a 2-pointer Pan run simultaneously on
 * the `accessible` canvas view (the testID is only in the accessibility tree because of `accessible`); a Manual
 * gesture only watches touches to count the most fingers down at once. The square follows the fingers live on the
 * UI thread; each gesture's `onEnd` folds its change into the base values (so the next gesture continues from here)
 * and commits the cumulative values to React state through `scheduleOnRN`. Translation is committed in dp, the
 * readout turns it into a fraction of the canvas size.
 */
export function GestureCanvas({ onCommit, onPointers }: GestureCanvasProps): ReactElement {
	const width = useSharedValue(0);
	const height = useSharedValue(CANVAS_HEIGHT);
	const scale = useSharedValue(1);
	const rotation = useSharedValue(0);
	const translateX = useSharedValue(0);
	const translateY = useSharedValue(0);
	const baseScale = useSharedValue(1);
	const baseRotation = useSharedValue(0);
	const baseX = useSharedValue(0);
	const baseY = useSharedValue(0);
	const maxPointers = useSharedValue(0);

	const publish = () => {
		"worklet";
		scheduleOnRN(onCommit, {
			scale: scale.get(),
			rotation: rotation.get(),
			translateX: translateX.get(),
			translateY: translateY.get(),
			size: { width: width.get(), height: height.get() },
		});
	};

	const pinch = Gesture.Pinch()
		.onUpdate((e) => {
			scale.set(baseScale.get() * e.scale);
		})
		.onEnd(() => {
			baseScale.set(scale.get());
			publish();
		});

	const rotate = Gesture.Rotation()
		.onUpdate((e) => {
			rotation.set(baseRotation.get() + e.rotation);
		})
		.onEnd(() => {
			baseRotation.set(rotation.get());
			publish();
		});

	const pan = Gesture.Pan()
		.minPointers(2)
		.maxPointers(2)
		.onUpdate((e) => {
			translateX.set(baseX.get() + e.translationX);
			translateY.set(baseY.get() + e.translationY);
		})
		.onEnd(() => {
			baseX.set(translateX.get());
			baseY.set(translateY.get());
			publish();
		});

	const touches = Gesture.Manual().onTouchesDown((e) => {
		if (e.numberOfTouches > maxPointers.get()) {
			maxPointers.set(e.numberOfTouches);
			scheduleOnRN(onPointers, e.numberOfTouches);
		}
	});

	const gesture = Gesture.Simultaneous(pinch, rotate, pan, touches);

	const squareStyle = useAnimatedStyle(() => ({
		transform: [
			{ translateX: translateX.get() },
			{ translateY: translateY.get() },
			{ scale: scale.get() },
			{ rotate: `${rotation.get()}rad` },
		],
	}));

	return (
		<GestureDetector gesture={gesture}>
			<View
				accessibilityLabel="Gesture canvas"
				accessible
				className="w-full items-center justify-center overflow-hidden rounded-2xl bg-muted"
				onLayout={(e) => {
					width.set(e.nativeEvent.layout.width);
					height.set(e.nativeEvent.layout.height);
				}}
				style={{ height: CANVAS_HEIGHT }}
				testID="gestures-canvas"
			>
				<Animated.View className="rounded-xl bg-accent" style={[{ width: SQUARE, height: SQUARE }, squareStyle]} />
			</View>
		</GestureDetector>
	);
}
