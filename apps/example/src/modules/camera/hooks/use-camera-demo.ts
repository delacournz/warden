import { type BarcodeScanningResult, type CameraType, type CameraView, useCameraPermissions } from "expo-camera";
import { launchCameraAsync } from "expo-image-picker";
import { useCallback, useRef, useState } from "react";

export type Shot = { width: number; height: number; uri: string };

/**
 * State behind the Camera demo: the permission, which camera is live, the last QR payload the preview decoded, the
 * last photo taken through the preview and the last photo the system image picker returned. The QR text keeps the
 * latest distinct payload, so a feed swapped to another code shows the new one.
 */
export function useCameraDemo() {
	const [permission, requestPermission] = useCameraPermissions();
	const camera = useRef<CameraView>(null);
	const [facing, setFacing] = useState<CameraType>("back");
	const [ready, setReady] = useState(false);
	const [qr, setQr] = useState("");
	const [shot, setShot] = useState<Shot | null>(null);
	const [picked, setPicked] = useState("none");
	const [error, setError] = useState("");

	const onScanned = useCallback((result: BarcodeScanningResult) => {
		setQr((previous) => (previous === result.data ? previous : result.data));
	}, []);

	const flip = useCallback(() => {
		setReady(false);
		setQr("");
		setFacing((f) => (f === "back" ? "front" : "back"));
	}, []);

	const takePhoto = useCallback(async () => {
		try {
			const photo = await camera.current?.takePictureAsync({ quality: 0.5 });
			if (photo) setShot({ width: photo.width, height: photo.height, uri: photo.uri });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	const pick = useCallback(async () => {
		try {
			const result = await launchCameraAsync({ mediaTypes: ["images"], quality: 0.5 });
			const asset = result.canceled ? undefined : result.assets[0];
			setPicked(asset ? `${asset.width}x${asset.height}` : "cancelled");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);

	return {
		permission,
		requestPermission,
		camera,
		facing,
		ready,
		onReady: () => setReady(true),
		qr,
		onScanned,
		flip,
		shot,
		takePhoto,
		picked,
		pick,
		error,
	};
}
