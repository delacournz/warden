import { describe, expect, test } from "bun:test";
import { BUILD_KINDS } from "@delacour/warden-config/build-kinds";
import { buildDefaults, DEFAULT_JS_INPUTS } from "./builds.defaults";
import { DEFAULT_E2E_KIND, DEFAULT_UI_KIND, kinds } from "./kinds";
import { buildsTesting } from "./testing/builds.testing";

describe("constants", () => {
	test("three kinds; e2e defaults to simulator, ui to dev", () => {
		expect(BUILD_KINDS).toEqual(["dev", "simulator", "release"]);
		expect(DEFAULT_E2E_KIND).toBe("simulator");
		expect(DEFAULT_UI_KIND).toBe("dev");
	});
});

describe("simulatorBuildCommand", () => {
	test("iOS skips Xcode's bundling phase in a Release build", () => {
		const cmd = buildDefaults.simulatorCommand("ios");
		expect(cmd).toContain("SKIP_BUNDLING=1 bunx expo run:ios --configuration Release --no-install --no-bundler");
		expect(cmd.startsWith("{ [ -f ios/Podfile ]")).toBe(true);
	});

	test("bare React Native iOS", () => {
		expect(buildDefaults.simulatorCommand("ios", "react-native")).toContain(
			"SKIP_BUNDLING=1 npx react-native build-ios --mode Release"
		);
	});

	test("Android builds one ABI and keeps the release bundle task (its images feed the resource table)", () => {
		const cmd = buildDefaults.simulatorCommand("android");
		expect(cmd).toContain("./gradlew app:assembleRelease");
		expect(cmd).not.toContain("-x ");
		expect(cmd).toContain("-PreactNativeArchitectures=");
		expect(cmd).toContain("expo prebuild --platform android");
		expect(buildDefaults.simulatorCommand("android", "react-native")).not.toContain("expo prebuild");
	});
});

describe("kindBuildCommand", () => {
	test("dev = the Debug default, release = the Release default, simulator = no bundle", () => {
		expect(kinds.buildCommand("dev", "ios", "expo")).toBe(buildDefaults.defaultCommand("ios", "Debug", "expo"));
		expect(kinds.buildCommand("release", "android", "expo")).toBe(
			buildDefaults.defaultCommand("android", "Release", "expo")
		);
		expect(kinds.buildCommand("simulator", "ios", "expo")).toBe(buildDefaults.simulatorCommand("ios", "expo"));
	});
});

describe("resolveKind", () => {
	test("built-in defaults per kind", () => {
		const project = buildsTesting.project();
		expect(kinds.resolve(project, "dev")).toMatchObject({
			kind: "dev",
			buildConfiguration: "Debug",
			embedsJs: false,
			fingerprint: "native",
			env: {},
		});
		const sim = kinds.resolve(project, "simulator");
		expect(sim).toMatchObject({ buildConfiguration: "Release", embedsJs: false, fingerprint: "native" });
		expect(sim.build.ios).toBe(buildDefaults.simulatorCommand("ios", "expo"));
		expect(sim.jsInputs).toEqual([...DEFAULT_JS_INPUTS]);
		const release = kinds.resolve(project, "release");
		expect(release).toMatchObject({ buildConfiguration: "Release", embedsJs: true, fingerprint: "native+js" });
		expect(release.build.android).toBe(buildDefaults.defaultCommand("android", "Release", "expo"));
		expect(release.jsInputs).toEqual([...DEFAULT_JS_INPUTS]);
	});

	test("dev has no js inputs", () => {
		expect(kinds.resolve(buildsTesting.project(), "dev").jsInputs).toBeUndefined();
	});

	test("kinds.<kind>.build beats the built-in default, per platform", () => {
		const project = buildsTesting.project({ kinds: { simulator: { build: { ios: "make sim" } } } });
		const sim = kinds.resolve(project, "simulator");
		expect(sim.build.ios).toBe("make sim");
		expect(sim.build.android).toBe(buildDefaults.simulatorCommand("android", "expo"));
	});

	test("the project's top-level build / fingerprint do not leak into a kind", () => {
		const project = buildsTesting.project({
			build: { ios: "custom debug", android: "custom android" },
			buildConfiguration: "Release",
			jsInputs: ["src/**"],
		});
		expect(kinds.resolve(project, "dev").build.ios).toBe(buildDefaults.defaultCommand("ios", "Debug", "expo"));
		expect(kinds.resolve(project, "dev").buildConfiguration).toBe("Debug");
		expect(kinds.resolve(project, "release").jsInputs).toEqual([...DEFAULT_JS_INPUTS]);
	});

	test("kinds.<kind>.jsInputs and env", () => {
		const project = buildsTesting.project({
			kinds: { simulator: { jsInputs: ["src/**", "../../packages/ui/src/**"], env: { EXPO_PUBLIC_API: "x" } } },
		});
		const sim = kinds.resolve(project, "simulator");
		expect(sim.jsInputs).toEqual(["src/**", "../../packages/ui/src/**"]);
		expect(sim.env).toEqual({ EXPO_PUBLIC_API: "x" });
	});

	test("framework picks the bare React Native commands", () => {
		const project = buildsTesting.project({ framework: "react-native" });
		expect(kinds.resolve(project, "dev").build.ios).toBe(buildDefaults.defaultCommand("ios", "Debug", "react-native"));
	});
});

describe("projectForKind", () => {
	test("a project the existing build / fingerprint code can run as is", () => {
		const base = buildsTesting.project({ kinds: { simulator: { env: { A: "1" } } } });
		const sim = kinds.projectFor(base, "simulator");
		expect(sim).toMatchObject({ kind: "simulator", buildConfiguration: "Release", buildEnv: { A: "1" } });
		expect(sim.build.ios).toBe(buildDefaults.simulatorCommand("ios", "expo"));
		expect(sim.jsInputs).toBeUndefined();
		expect(kinds.projectFor(base, "release").jsInputs).toEqual([...DEFAULT_JS_INPUTS]);
		expect(kinds.projectFor(base, "dev").buildConfiguration).toBe("Debug");
	});

	test("clears a variant-derived jsInputs when the kind does not embed JS", () => {
		const base = buildsTesting.project({ jsInputs: ["src/**"] });
		expect(kinds.projectFor(base, "dev").jsInputs).toBeUndefined();
	});
});

describe("device builds", () => {
	test("iosDeviceBuildCommand: a signed xcodebuild for any device, products in ios/build", () => {
		const cmd = buildDefaults.iosDeviceCommand("Release", "expo", { team: "ABCDE12345" });
		expect(cmd).toContain(
			'&& cd ios && ws="$(ls -d *.xcworkspace | head -n 1)" && RCT_NO_LAUNCH_PACKAGER=1 xcodebuild'
		);
		expect(cmd).toContain(`-workspace "$ws" -scheme "\${ws%.xcworkspace}" -configuration Release`);
		expect(cmd).toContain("-destination generic/platform=iOS -derivedDataPath build -allowProvisioningUpdates");
		expect(cmd).toContain("CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM=ABCDE12345 build");
		expect(cmd).not.toContain("PRODUCT_BUNDLE_IDENTIFIER");
		expect(cmd.startsWith("{ [ -f ios/Podfile ]")).toBe(true);
	});

	test("iosDeviceBuildCommand: the bundle id override and bare React Native pods", () => {
		const cmd = buildDefaults.iosDeviceCommand("Release", "react-native", {
			team: "ABCDE12345",
			bundleIdentifier: "com.me.app",
		});
		expect(cmd).toContain("DEVELOPMENT_TEAM=ABCDE12345 PRODUCT_BUNDLE_IDENTIFIER=com.me.app build");
		expect(cmd).not.toContain("expo prebuild");
		expect(cmd).toContain("pod install --project-directory=ios");
	});

	test("deviceTarget: the salt follows the team and the bundle id override", () => {
		const plain = buildsTesting.project();
		const overridden = buildsTesting.project({ iosDeviceBundleId: "com.me.app" });
		expect(kinds.deviceTarget(plain, "ABCDE12345")).toEqual({ team: "ABCDE12345", salt: "ABCDE12345" });
		expect(kinds.deviceTarget(plain, "ZZZZZ99999").salt).not.toBe(kinds.deviceTarget(plain, "ABCDE12345").salt);
		const salt = kinds.deviceTarget(overridden, "ABCDE12345").salt;
		expect(salt).toMatch(/^ABCDE12345-[0-9a-f]{8}$/);
		expect(
			kinds.deviceTarget(buildsTesting.project({ iosDeviceBundleId: "com.me.other" }), "ABCDE12345").salt
		).not.toBe(salt);
	});

	test("projectForKind with a device target: target, device command, device bundle id", () => {
		const project = buildsTesting.project({ iosDeviceBundleId: "com.me.app" });
		const resolved = kinds.projectFor(project, "release", kinds.deviceTarget(project, "ABCDE12345"));
		expect(resolved.target).toBe("device");
		expect(resolved.bundleId.ios).toBe("com.me.app");
		expect(resolved.bundleId.android).toBe("com.x.app");
		expect(resolved.build.ios).toContain("DEVELOPMENT_TEAM=ABCDE12345 PRODUCT_BUNDLE_IDENTIFIER=com.me.app");
		expect(resolved.build.android).toBe(kinds.buildCommand("release", "android", "expo"));
		expect(kinds.projectFor(project, "release").target).toBeUndefined();
		expect(kinds.projectFor(project, "release").bundleId.ios).toBe("com.x.app");
	});

	test("kinds.<kind>.build.ios still replaces the device command", () => {
		const project = buildsTesting.project({ kinds: { release: { build: { ios: "my-build" } } } });
		expect(kinds.resolve(project, "release", kinds.deviceTarget(project, "ABCDE12345")).build.ios).toBe("my-build");
	});

	test("withDeviceBundleId leaves a project without an override alone", () => {
		const project = buildsTesting.project();
		expect(kinds.withDeviceBundleId(project)).toBe(project);
	});
});
