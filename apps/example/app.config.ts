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
		},
		bundleIdentifier: "nz.co.delacour.warden.example",
	},
	android: {
		package: "nz.co.delacour.warden.example",
	},
	plugins: [
		"expo-router",
		"expo-status-bar",
		"expo-system-ui",
		[
			"expo-dev-client",
			{
				launchMode: "most-recent",
			},
		],
		// Xcode 27's iOS SDK requires the UIScene lifecycle; the SDK 57 prebuild template has none, so an app built
		// with it traps at launch (NoSceneLifecycleAdoption). The plugin adds the scene manifest and delegate.
		[
			"expo-build-properties",
			{
				ios: {
					enableSceneSupport: true,
				},
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
