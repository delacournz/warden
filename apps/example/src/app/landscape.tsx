import { router } from "expo-router";
import { useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { Button } from "@/components/ui/button";
import { Screen } from "@/components/ui/screen";
import { Text } from "@/components/ui/text";

const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
type Corner = (typeof CORNERS)[number];

/**
 * Tap targets for a turned device, reachable at `warden-example://landscape`. One button per corner and a readout of
 * the last one pressed: a touch sent on the wrong axes lands on another corner or on nothing, never on the one asked
 * for. `landscape-layout` says which way the window is drawn, so a spec can tell the app really rotated.
 */
export default function Landscape() {
	const [last, setLast] = useState<Corner | "none">("none");
	const [presses, setPresses] = useState(0);
	const { width, height } = useWindowDimensions();

	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const press = (corner: Corner) => () => {
		setLast(corner);
		setPresses((count) => count + 1);
	};

	return (
		<Screen testID="landscape-screen">
			<Screen.Navbar>
				<Screen.Navbar.BackButton onPress={back} testID="landscape-back">
					<Screen.Navbar.Title>Landscape</Screen.Navbar.Title>
				</Screen.Navbar.BackButton>
			</Screen.Navbar>
			<Screen.View className="flex-1 justify-between px-5 pt-2 pb-4">
				<View className="flex-row justify-between">
					<Button onPress={press("top-left")} size="sm" testID="landscape-top-left" variant="outline">
						Top left
					</Button>
					<Button onPress={press("top-right")} size="sm" testID="landscape-top-right" variant="outline">
						Top right
					</Button>
				</View>
				<View className="items-center gap-1">
					<Text.Label testID="landscape-last">{last}</Text.Label>
					<Text.Caption testID="landscape-presses">{String(presses)}</Text.Caption>
					<Text.Caption testID="landscape-layout">{width > height ? "landscape" : "portrait"}</Text.Caption>
				</View>
				<View className="flex-row justify-between">
					<Button onPress={press("bottom-left")} size="sm" testID="landscape-bottom-left" variant="outline">
						Bottom left
					</Button>
					<Button onPress={press("bottom-right")} size="sm" testID="landscape-bottom-right" variant="outline">
						Bottom right
					</Button>
				</View>
			</Screen.View>
		</Screen>
	);
}
