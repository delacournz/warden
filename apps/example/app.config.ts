import type { ExpoConfig } from "expo/config";

const expoConfig: ExpoConfig = {
	name: "warden-example",
	slug: "warden-example",
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
	],
	experiments: {
		typedRoutes: true,
		tsconfigPaths: true,
		reactCompiler: true,
	},
};

export default expoConfig;
