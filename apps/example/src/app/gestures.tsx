import { router } from "expo-router";
import { Screen } from "@/components/ui/screen";
import { GestureCanvas } from "@/modules/gestures/components/gesture-canvas";
import { GestureReadouts } from "@/modules/gestures/components/gesture-readouts";
import { TracePad } from "@/modules/gestures/components/trace-pad";
import { useGestureReadout } from "@/modules/gestures/hooks/use-gesture-readout";

/**
 * Gesture playground, reachable from Settings or `warden-example://gestures`. A plain `Screen.View` (not a scroll
 * area) so no scroll competes with the pans; the surfaces are keyed by `resetKey` so Reset restarts their animation.
 */
export default function Gestures() {
	const { readout, resetKey, commitTransform, commitPointers, commitTrace, reset } = useGestureReadout();

	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));

	return (
		<Screen testID="gestures-screen">
			<Screen.Navbar>
				<Screen.Navbar.BackButton onPress={back} testID="gestures-back">
					<Screen.Navbar.Title>Gestures</Screen.Navbar.Title>
				</Screen.Navbar.BackButton>
			</Screen.Navbar>
			<Screen.View className="gap-3 px-5">
				<GestureCanvas key={`canvas-${resetKey}`} onCommit={commitTransform} onPointers={commitPointers} />
				<TracePad key={`trace-${resetKey}`} onCommit={commitTrace} />
				<GestureReadouts onReset={reset} readout={readout} />
			</Screen.View>
		</Screen>
	);
}
