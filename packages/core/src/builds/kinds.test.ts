import { describe, expect, test } from "bun:test";
import { DEFAULT_JS_INPUTS, defaultBuildCommand, simulatorBuildCommand } from "./builds.defaults";
import { testProject } from "./builds.testing";
import { BUILD_KINDS, DEFAULT_E2E_KIND, DEFAULT_UI_KIND, kindBuildCommand, projectForKind, resolveKind } from "./kinds";

describe("constants", () => {
	test("three kinds; e2e defaults to simulator, ui to dev", () => {
		expect(BUILD_KINDS).toEqual(["dev", "simulator", "release"]);
		expect(DEFAULT_E2E_KIND).toBe("simulator");
		expect(DEFAULT_UI_KIND).toBe("dev");
	});
});

describe("simulatorBuildCommand", () => {
	test("iOS skips Xcode's bundling phase in a Release build", () => {
		const cmd = simulatorBuildCommand("ios");
		expect(cmd).toContain("SKIP_BUNDLING=1 bunx expo run:ios --configuration Release --no-install --no-bundler");
		expect(cmd.startsWith("{ [ -f ios/Podfile ]")).toBe(true);
	});

	test("bare React Native iOS", () => {
		expect(simulatorBuildCommand("ios", "react-native")).toContain(
			"SKIP_BUNDLING=1 npx react-native build-ios --mode Release"
		);
	});

	test("Android builds one ABI and keeps the release bundle task (its images feed the resource table)", () => {
		const cmd = simulatorBuildCommand("android");
		expect(cmd).toContain("./gradlew app:assembleRelease");
		expect(cmd).not.toContain("-x ");
		expect(cmd).toContain("-PreactNativeArchitectures=");
		expect(cmd).toContain("expo prebuild --platform android");
		expect(simulatorBuildCommand("android", "react-native")).not.toContain("expo prebuild");
	});
});

describe("kindBuildCommand", () => {
	test("dev = the Debug default, release = the Release default, simulator = no bundle", () => {
		expect(kindBuildCommand("dev", "ios", "expo")).toBe(defaultBuildCommand("ios", "Debug", "expo"));
		expect(kindBuildCommand("release", "android", "expo")).toBe(defaultBuildCommand("android", "Release", "expo"));
		expect(kindBuildCommand("simulator", "ios", "expo")).toBe(simulatorBuildCommand("ios", "expo"));
	});
});

describe("resolveKind", () => {
	test("built-in defaults per kind", () => {
		const project = testProject();
		expect(resolveKind(project, "dev")).toMatchObject({
			kind: "dev",
			buildConfiguration: "Debug",
			embedsJs: false,
			fingerprint: "native",
			env: {},
		});
		const sim = resolveKind(project, "simulator");
		expect(sim).toMatchObject({ buildConfiguration: "Release", embedsJs: false, fingerprint: "native" });
		expect(sim.build.ios).toBe(simulatorBuildCommand("ios", "expo"));
		expect(sim.jsInputs).toEqual([...DEFAULT_JS_INPUTS]);
		const release = resolveKind(project, "release");
		expect(release).toMatchObject({ buildConfiguration: "Release", embedsJs: true, fingerprint: "native+js" });
		expect(release.build.android).toBe(defaultBuildCommand("android", "Release", "expo"));
		expect(release.jsInputs).toEqual([...DEFAULT_JS_INPUTS]);
	});

	test("dev has no js inputs", () => {
		expect(resolveKind(testProject(), "dev").jsInputs).toBeUndefined();
	});

	test("kinds.<kind>.build beats the built-in default, per platform", () => {
		const project = testProject({ kinds: { simulator: { build: { ios: "make sim" } } } });
		const sim = resolveKind(project, "simulator");
		expect(sim.build.ios).toBe("make sim");
		expect(sim.build.android).toBe(simulatorBuildCommand("android", "expo"));
	});

	test("the project's top-level build / fingerprint do not leak into a kind", () => {
		const project = testProject({
			build: { ios: "custom debug", android: "custom android" },
			buildConfiguration: "Release",
			jsInputs: ["src/**"],
		});
		expect(resolveKind(project, "dev").build.ios).toBe(defaultBuildCommand("ios", "Debug", "expo"));
		expect(resolveKind(project, "dev").buildConfiguration).toBe("Debug");
		expect(resolveKind(project, "release").jsInputs).toEqual([...DEFAULT_JS_INPUTS]);
	});

	test("kinds.<kind>.jsInputs and env", () => {
		const project = testProject({
			kinds: { simulator: { jsInputs: ["src/**", "../../packages/ui/src/**"], env: { EXPO_PUBLIC_API: "x" } } },
		});
		const sim = resolveKind(project, "simulator");
		expect(sim.jsInputs).toEqual(["src/**", "../../packages/ui/src/**"]);
		expect(sim.env).toEqual({ EXPO_PUBLIC_API: "x" });
	});

	test("framework picks the bare React Native commands", () => {
		const project = testProject({ framework: "react-native" });
		expect(resolveKind(project, "dev").build.ios).toBe(defaultBuildCommand("ios", "Debug", "react-native"));
	});
});

describe("projectForKind", () => {
	test("a project the existing build / fingerprint code can run as is", () => {
		const base = testProject({ kinds: { simulator: { env: { A: "1" } } } });
		const sim = projectForKind(base, "simulator");
		expect(sim).toMatchObject({ kind: "simulator", buildConfiguration: "Release", buildEnv: { A: "1" } });
		expect(sim.build.ios).toBe(simulatorBuildCommand("ios", "expo"));
		expect(sim.jsInputs).toBeUndefined();
		expect(projectForKind(base, "release").jsInputs).toEqual([...DEFAULT_JS_INPUTS]);
		expect(projectForKind(base, "dev").buildConfiguration).toBe("Debug");
	});

	test("clears a variant-derived jsInputs when the kind does not embed JS", () => {
		const base = testProject({ jsInputs: ["src/**"] });
		expect(projectForKind(base, "dev").jsInputs).toBeUndefined();
	});
});
