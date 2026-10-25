import type { ReactElement } from "react";
import { View } from "react-native";
import { Button } from "@/components/ui/button";
import { Text } from "@/components/ui/text";
import type { GestureReadout } from "../hooks/use-gesture-readout";
import { formatDegrees, formatScale, fraction } from "../utils/readout";

type GestureReadoutsProps = {
	readout: GestureReadout;
	onReset: () => void;
};

type ReadoutCellProps = { label: string; value: string; testID: string };

/** One "label value" cell; only the value carries the testID, so a spec reads exactly the number. */
function ReadoutCell({ label, value, testID }: ReadoutCellProps): ReactElement {
	return (
		<View className="w-1/2 flex-row items-baseline gap-2">
			<Text.Caption>{label}</Text.Caption>
			<Text.Label testID={testID}>{value}</Text.Label>
		</View>
	);
}

/**
 * The committed gesture values as text, one testID per value, plus a reset button.
 *
 * Rotation is in whole degrees, positive clockwise on both platforms: react-native-gesture-handler reports radians
 * with the same sign as a CSS/RN `rotate` (iOS UIRotationGestureRecognizer is clockwise-positive; on Android the
 * handler negates `atan2` of the finger vector, whose y axis points down, to match). Pan is the two-finger
 * translation as a fraction of the canvas size; the trace end is the last stroke's end as a fraction of the pad.
 */
export function GestureReadouts({ readout, onReset }: GestureReadoutsProps): ReactElement {
	const traceEnd = `${fraction(readout.traceEndX, readout.pad.width)},${fraction(readout.traceEndY, readout.pad.height)}`;
	const traceLength = readout.pad.width === 0 ? 0 : readout.traceLength / readout.pad.width;

	return (
		<View className="gap-2">
			<View className="flex-row flex-wrap gap-y-1">
				<ReadoutCell label="Scale" testID="gestures-scale" value={formatScale(readout.scale)} />
				<ReadoutCell label="Rotation" testID="gestures-rotation" value={formatDegrees(readout.rotation)} />
				<ReadoutCell label="Pan x" testID="gestures-pan-x" value={fraction(readout.translateX, readout.canvas.width)} />
				<ReadoutCell
					label="Pan y"
					testID="gestures-pan-y"
					value={fraction(readout.translateY, readout.canvas.height)}
				/>
				<ReadoutCell label="Pointers" testID="gestures-pointers" value={String(readout.pointers)} />
				<ReadoutCell label="Trace" testID="gestures-trace-length" value={traceLength.toFixed(2)} />
				<ReadoutCell label="Trace end" testID="gestures-trace-end" value={traceEnd} />
			</View>
			<Button onPress={onReset} size="sm" testID="gestures-reset" variant="outline">
				Reset
			</Button>
		</View>
	);
}
