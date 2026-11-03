import { IconCamera1, IconChevronLeft } from "@central-icons-react-native/round-outlined-radius-1-stroke-1.5";
import { CameraView } from "expo-camera";
import { router } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Image, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useCameraDemo } from "@/modules/camera/hooks/use-camera-demo";

/** One `label  value` readout line; the value is `accessible` so its testID reaches the AX tree. */
function Readout({ label, value, testID }: { label: string; value: string; testID: string }) {
	return (
		<View className="flex-row justify-between">
			<Text className="font-mono text-[13px] text-tertiary-foreground">{label}</Text>
			<Text accessible className="font-mono text-[13px] text-foreground" testID={testID}>
				{value}
			</Text>
		</View>
	);
}

/** A full-width pill button with a testID. */
function Action({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) {
	return (
		<Pressable
			accessibilityLabel={label}
			accessibilityRole="button"
			accessible
			className="h-12 flex-1 items-center justify-center rounded-full border border-border active:opacity-85"
			onPress={onPress}
			testID={testID}
		>
			<Text className="font-heading text-base text-foreground">{label}</Text>
		</Pressable>
	);
}

/**
 * Camera demo for the simulated camera (`device.camera`, `warden ui camera`): a live expo-camera preview that
 * scans QR codes, a photo taken through it, a flip between back and front, and the system image picker's camera.
 * The readouts are what the specs assert on: `camera-ready`, `camera-facing`, `camera-qr`, `camera-photo`,
 * `camera-picked`, `camera-error` (`none` when empty: an empty text is not in the AX tree). Without the permission it shows only the Allow button (`camera-allow`).
 * Reachable from Settings or `warden-example://camera`.
 */
export default function Camera() {
	const demo = useCameraDemo();
	const insets = useSafeAreaInsets();
	const foreground = useThemeColor("foreground");
	const back = () => (router.canGoBack() ? router.back() : router.replace("/"));
	const granted = demo.permission?.granted === true;
	const shot = demo.shot;

	return (
		<View className="flex-1 bg-background" style={{ paddingTop: insets.top }} testID="camera-screen">
			<StatusBar style="light" />
			<View className="h-[52px] flex-row items-center justify-between px-5">
				<Pressable
					accessibilityLabel="Back"
					accessibilityRole="button"
					accessible
					className="flex-row items-center gap-1.5"
					hitSlop={12}
					onPress={back}
					testID="camera-back"
				>
					<IconChevronLeft color={foreground} size={22} />
					<Text className="font-heading text-lg text-foreground">Camera</Text>
				</Pressable>
				<IconCamera1 color={foreground} size={18} />
			</View>

			{granted ? (
				<View className="flex-1 gap-4 px-6 pb-4">
					<View className="h-[280px] overflow-hidden rounded-2xl bg-card" testID="camera-preview">
						<CameraView
							barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
							facing={demo.facing}
							onBarcodeScanned={demo.onScanned}
							onCameraReady={demo.onReady}
							ref={demo.camera}
							style={{ flex: 1 }}
						/>
					</View>
					<View className="gap-2 border-border border-y py-3">
						<Readout label="ready" testID="camera-ready" value={demo.ready ? "ready" : "starting"} />
						<Readout label="facing" testID="camera-facing" value={demo.facing} />
						<Readout label="qr" testID="camera-qr" value={demo.qr || "none"} />
						<Readout label="photo" testID="camera-photo" value={shot ? `${shot.width}x${shot.height}` : "none"} />
						<Readout label="picked" testID="camera-picked" value={demo.picked} />
						<Readout label="error" testID="camera-error" value={demo.error || "none"} />
					</View>
					{shot && <Image className="h-16 w-16 rounded-lg" source={{ uri: shot.uri }} testID="camera-thumb" />}
				</View>
			) : (
				<View className="flex-1 items-center justify-center gap-4 px-6">
					<Text className="font-sans text-center text-base text-muted-foreground">
						The camera demo needs camera access.
					</Text>
					<View className="h-12 w-full flex-row">
						<Action label="Allow camera" onPress={demo.requestPermission} testID="camera-allow" />
					</View>
				</View>
			)}

			{granted && (
				<View className="flex-row gap-3 px-6 pt-1" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
					<Action label="Photo" onPress={demo.takePhoto} testID="camera-shoot" />
					<Action label="Flip" onPress={demo.flip} testID="camera-flip" />
					<Action label="Picker" onPress={demo.pick} testID="camera-pick" />
				</View>
			)}
		</View>
	);
}
