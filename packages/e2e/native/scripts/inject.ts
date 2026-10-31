#!/usr/bin/env bun
/**
 * `bun native/scripts/inject.ts` — build `libwarden-inject.dylib` (arm64, iOS simulator) into `native/dist/`.
 * One Objective-C file, no SwiftPM and no idb libraries, so it builds on its own (`native:inject`) and `native:build`
 * runs it after the helper (which recreates `dist/`). `--macos <out-dir>` builds the same source for the host plus the
 * test harness, which is how `inject.test.ts` exercises it without a simulator.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bunExec, type Exec, execError } from "@delacour/warden-core/exec";

const NATIVE_DIR = resolve(import.meta.dir, "..");
export const INJECT_SOURCE = join(NATIVE_DIR, "ios-inject", "WardenInject.m");
export const HARNESS_SOURCE = join(NATIVE_DIR, "ios-inject", "harness", "harness.m");
export const INJECT_DYLIB = "libwarden-inject.dylib";
/** Lowest iOS the dylib loads on; the example app and RN 0.7x need 15.1. */
export const IOS_MIN = "15.0";

export type Target = "ios-simulator" | "macos";

/** SCNetworkReachability is deprecated but is what older NetInfo builds call: interposing it is the point. */
const FLAGS = ["-Wall", "-Werror", "-Wno-deprecated-declarations"];
const FRAMEWORKS = ["-framework", "Foundation", "-framework", "Network", "-framework", "SystemConfiguration"];
/** The accessibility read (A11Y-1) walks UIKit, which only the simulator build has. */
const UIKIT = ["-framework", "UIKit"];

/** `xcrun clang` argv for the injected dylib on `target`. */
export function dylibArgv(target: Target, out: string): string[] {
	const sdk = target === "ios-simulator" ? "iphonesimulator" : "macosx";
	const min = target === "ios-simulator" ? `-mios-simulator-version-min=${IOS_MIN}` : "-mmacosx-version-min=15.0";
	return [
		"xcrun",
		"--sdk",
		sdk,
		"clang",
		"-arch",
		"arm64",
		min,
		"-dynamiclib",
		"-fobjc-arc",
		"-O2",
		...FLAGS,
		"-install_name",
		`@rpath/${INJECT_DYLIB}`,
		...FRAMEWORKS,
		...(target === "ios-simulator" ? UIKIT : []),
		INJECT_SOURCE,
		"-o",
		out,
	];
}

/** `xcrun clang` argv for the macOS test harness. */
export function harnessArgv(out: string): string[] {
	return [
		"xcrun",
		"--sdk",
		"macosx",
		"clang",
		"-arch",
		"arm64",
		"-mmacosx-version-min=15.0",
		"-fobjc-arc",
		...FLAGS,
		...FRAMEWORKS,
		HARNESS_SOURCE,
		"-o",
		out,
	];
}

async function run(exec: Exec, cmd: readonly string[]): Promise<string> {
	const result = await exec(cmd);
	if (result.exitCode !== 0) throw new Error(execError(cmd, result));
	return result.stdout;
}

/** Compile + ad-hoc sign the dylib at `out`. */
export async function buildDylib(exec: Exec, target: Target, out: string): Promise<void> {
	await run(exec, dylibArgv(target, out));
	await run(exec, ["codesign", "-s", "-", "--force", out]);
}

export async function main(argv: readonly string[]): Promise<number> {
	const exec = bunExec;
	const macosAt = argv.indexOf("--macos");
	if (macosAt >= 0) {
		const dir = argv[macosAt + 1];
		if (!dir) throw new Error("--macos needs an output directory");
		await mkdir(dir, { recursive: true });
		await buildDylib(exec, "macos", join(dir, INJECT_DYLIB));
		await run(exec, harnessArgv(join(dir, "harness")));
		console.log(`inject: macOS dylib + harness in ${dir}`);
		return 0;
	}
	const dist = join(NATIVE_DIR, "dist");
	await mkdir(dist, { recursive: true });
	const out = join(dist, INJECT_DYLIB);
	await buildDylib(exec, "ios-simulator", out);
	const info = await run(exec, ["lipo", "-info", out]);
	const platform = await run(exec, ["vtool", "-show-build", out]);
	if (!/platform IOSSIMULATOR/.test(platform)) throw new Error(`${out} is not an iOS simulator binary:\n${platform}`);
	console.log(`inject: dist/${INJECT_DYLIB} (${info.trim().split(": ").pop()}, iOS simulator)`);
	return 0;
}

if (import.meta.main) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error: unknown) => {
			console.error(`inject: ${error instanceof Error ? error.message : String(error)}`);
			process.exit(1);
		}
	);
}
