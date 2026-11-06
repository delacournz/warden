import type { ExpoConfig } from "expo/config";

const expoConfig: ExpoConfig = {
	name: "warden-example",
	slug: "warden",
	owner: "delacour",
	scheme: "warden-example",
	version: "0.0.0",
	orientation: "portrait",
	userInterfaceStyle: "automatic",
	platforms: ["ios", "android"],
	ios: {
		supportsTablet: false,
		infoPlist: {
			ITSAppUsesNonExemptEncryption: false,
			NSLocationWhenInUseUsageDescription: "The Location and Conditions screens show your position and a geofence.",
		},
		bundleIdentifier: "nz.co.delacour.warden.example",
	},
	android: {
		package: "nz.co.delacour.warden.example",
		permissions: ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION", "android.permission.USE_BIOMETRIC"],
	},
	plugins: [
		"expo-router",
		"expo-status-bar",
		"expo-system-ui",
		[
			"expo-location",
			{
				locationWhenInUsePermission: "The Location and Conditions screens show your position and a geofence.",
			},
		],
		"expo-notifications",
		[
			"expo-camera",
			{
				cameraPermission: "The Camera screen shows a live preview, scans QR codes and takes photos.",
				microphonePermission: false,
				recordAudioAndroid: false,
			},
		],
		[
			"expo-image-picker",
			{
				cameraPermission: "The Camera screen takes a photo with the system camera.",
				microphonePermission: false,
				photosPermission: false,
			},
		],
		[
			"expo-local-authentication",
			{
				faceIDPermission: "Allow $(PRODUCT_NAME) to use Face ID to unlock the biometrics demo.",
			},
		],
		[
			"expo-dev-client",
			{
				launchMode: "most-recent",
			},
		],
	],
	extra: {
		eas: {
			projectId: "3a348f4a-7e11-49ed-9bd9-425b8878af00",
		},
	},
	experiments: {
		typedRoutes: true,
		tsconfigPaths: true,
		reactCompiler: true,
	},
};

export default expoConfig;
