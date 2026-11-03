import { createHash } from "node:crypto";
import type { Platform } from "../types";
import {
	type BuildConfiguration,
	DEFAULT_JS_INPUTS,
	defaultBuildCommand,
	iosDeviceBuildCommand,
	simulatorBuildCommand,
} from "./builds.defaults";
import type { Project } from "./config";
import type { AppFramework } from "./native-ids";

/**
 * What a cached build is for:
 * - `dev`: Debug, JS from Metro at runtime.
 * - `simulator`: Release for a simulator / emulator with no JS bundle embedded; a repack supplies the JS.
 * - `release`: Release with the JS bundle embedded at build time (the key also covers the JS sources).
 */
export type BuildKind = "dev" | "simulator" | "release";

export const BUILD_KINDS = ["dev", "simulator", "release"] as const satisfies readonly BuildKind[];

/**
 * What a build runs on, separate from its kind: `simulator` builds (every kind so far) run on simulators and
 * emulators, `device` builds are signed for a physical iPhone. v1: only `dev` and `release` have a device build.
 */
export type BuildTarget = "simulator" | "device";

/**
 * A device-target build's identity: the signing `team` and a `salt` (the team, plus a hash of the bundle id
 * override when `projects[].ios.device.bundleIdentifier` is set) that goes into the cache key and the cache path.
 */
export type DeviceTarget = { team: string; salt: string };

/** The device target of `project` signed by `team`: a changed team or bundle id override is a different build. */
export function deviceTarget(project: Project, team: string): DeviceTarget {
	const override = project.iosDeviceBundleId;
	if (override === undefined) return { team, salt: team };
	return { team, salt: `${team}-${createHash("sha1").update(override).digest("hex").slice(0, 8)}` };
}

/** `project` with the bundle id a device build installs under (`projects[].ios.device.bundleIdentifier`, else its own). */
export function withDeviceBundleId(project: Project): Project {
	const override = project.iosDeviceBundleId;
	return override === undefined ? project : { ...project, bundleId: { ...project.bundleId, ios: override } };
}

/** The kind `warden e2e` installs when the suite's `app` names none. */
export const DEFAULT_E2E_KIND: BuildKind = "simulator";
/** The kind `warden ui open` / `warden dev` use when no `--kind` is given. */
export const DEFAULT_UI_KIND: BuildKind = "dev";

/** `projects[].kinds.<kind>`: overrides of one kind's built-in defaults. */
export type KindConfig = {
	/** replaces the kind's built-in build command, per platform */
	build?: { ios?: string | undefined; android?: string | undefined } | undefined;
	/** env of the build and of the JS bundle step (`EXPO_PUBLIC_*`, `NODE_ENV`…); part of the JS key */
	env?: Record<string, string> | undefined;
	/** globs (relative to the project root, `!` excludes) of the JS sources the key covers; `simulator` / `release` only */
	jsInputs?: string[] | undefined;
};

export type ProjectKinds = Partial<Record<BuildKind, KindConfig | undefined>>;

/** A kind's effective build settings: the built-in defaults with `projects[].kinds.<kind>` applied. */
export type KindSettings = {
	kind: BuildKind;
	build: Record<Platform, string>;
	buildConfiguration: BuildConfiguration;
	/** the app binary carries its JS (`release`); false = Metro or a repack supplies it */
	embedsJs: boolean;
	/** `native`: the key is the native fingerprint; `native+js`: also the `jsInputs` content */
	fingerprint: "native" | "native+js";
	env: Record<string, string>;
	/** the JS sources the JS key (`simulator`, `release`) covers; undefined for `dev` */
	jsInputs?: string[];
};

type KindDefaults = {
	configuration: BuildConfiguration;
	embedsJs: boolean;
	fingerprint: "native" | "native+js";
	command: (platform: Platform, framework: AppFramework) => string;
};

const KIND_DEFAULTS: Record<BuildKind, KindDefaults> = {
	dev: {
		configuration: "Debug",
		embedsJs: false,
		fingerprint: "native",
		command: (platform, framework) => defaultBuildCommand(platform, "Debug", framework),
	},
	simulator: {
		configuration: "Release",
		embedsJs: false,
		fingerprint: "native",
		command: simulatorBuildCommand,
	},
	release: {
		configuration: "Release",
		embedsJs: true,
		fingerprint: "native+js",
		command: (platform, framework) => defaultBuildCommand(platform, "Release", framework),
	},
};

/** The built-in build command of `kind` (the default `projects[].kinds.<kind>.build` replaces). */
export function kindBuildCommand(kind: BuildKind, platform: Platform, framework: AppFramework): string {
	return KIND_DEFAULTS[kind].command(platform, framework);
}

/**
 * `kind`'s settings for `project`. Precedence: `kinds.<kind>.build` > the built-in default. The project's top-level
 * `build` / `fingerprint.include` / `fingerprint.jsInputs` belong to the kind-less flow and are not read here
 * (`fingerprint.command`, `build.cache` and `build.prebuiltReactNative` still apply: they are not about the kind).
 * JS inputs: `kinds.<kind>.jsInputs`, else `DEFAULT_JS_INPUTS` (all tracked files but `ios/`, `android/`, `node_modules`).
 */
export function resolveKind(project: Project, kind: BuildKind, device?: DeviceTarget): KindSettings {
	const defaults = KIND_DEFAULTS[kind];
	const config = project.kinds?.[kind];
	const deviceBuild = device
		? iosDeviceBuildCommand(defaults.configuration, project.framework, {
				team: device.team,
				bundleIdentifier: project.iosDeviceBundleId,
			})
		: undefined;
	const settings: KindSettings = {
		kind,
		build: {
			ios: config?.build?.ios ?? deviceBuild ?? defaults.command("ios", project.framework),
			android: config?.build?.android ?? defaults.command("android", project.framework),
		},
		buildConfiguration: defaults.configuration,
		embedsJs: defaults.embedsJs,
		fingerprint: defaults.fingerprint,
		env: { ...config?.env },
	};
	if (kind !== "dev") settings.jsInputs = config?.jsInputs ?? [...DEFAULT_JS_INPUTS];
	return settings;
}

/**
 * `project` as `kind` builds it: the build commands, configuration and env of `resolveKind`, and `jsInputs` set only
 * when the kind's cache key covers the JS (`release`), so `runLocalBuild` / `computeCacheKey` run unchanged. With a
 * `device` target the project builds for a physical iPhone: the signed `xcodebuild` command, the device bundle id.
 */
export function projectForKind(project: Project, kind: BuildKind, device?: DeviceTarget): Project {
	const settings = resolveKind(project, kind, device);
	const { jsInputs: _own, ...rest } = device ? withDeviceBundleId(project) : project;
	const resolved: Project = {
		...rest,
		...(device ? { target: "device" as const } : {}),
		build: settings.build,
		buildConfiguration: settings.buildConfiguration,
		kind,
	};
	if (settings.env && Object.keys(settings.env).length > 0) resolved.buildEnv = settings.env;
	if (settings.fingerprint === "native+js" && settings.jsInputs) resolved.jsInputs = settings.jsInputs;
	return resolved;
}
