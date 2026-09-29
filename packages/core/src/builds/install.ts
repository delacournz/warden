import { type AsyncResult, err, ok } from "@warden/types/result";
import { type Exec, execError } from "../exec";
import { androidTools } from "../providers/android";
import type { Platform } from "../types";

export type InstallerDeps = { exec: Exec; env: Record<string, string | undefined> };

/** A device to install onto: iOS simulator udid / Android emulator serial. */
export type InstallTarget = { platform: Platform; deviceId: string };

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** `xcrun simctl install <udid> <app>` / `adb -s <serial> install -r <apk>`. */
export function installArgv(target: InstallTarget, appPath: string, env: InstallerDeps["env"]): string[] {
	return target.platform === "ios"
		? ["xcrun", "simctl", "install", target.deviceId, appPath]
		: [androidTools(env).adb, "-s", target.deviceId, "install", "-r", appPath];
}

/** `xcrun simctl get_app_container <udid> <bundleId>` / `adb -s <serial> shell pm path <bundleId>`. */
export function probeArgv(target: InstallTarget, bundleId: string, env: InstallerDeps["env"]): string[] {
	return target.platform === "ios"
		? ["xcrun", "simctl", "get_app_container", target.deviceId, bundleId]
		: [androidTools(env).adb, "-s", target.deviceId, "shell", "pm", "path", bundleId];
}

/** Is `bundleId` installed on the device? (simctl exits non-zero / `pm path` prints nothing when not.) */
export async function isAppInstalled(
	deps: InstallerDeps,
	target: InstallTarget,
	bundleId: string
): AsyncResult<boolean> {
	const res = await deps.exec(probeArgv(target, bundleId, deps.env));
	if (target.platform === "ios") return ok(res.exitCode === 0 && res.stdout.trim() !== "");
	return ok(res.exitCode === 0 && res.stdout.includes("package:"));
}

/** Install `appPath`, then confirm `bundleId` is present. */
export async function installApp(
	deps: InstallerDeps,
	target: InstallTarget,
	appPath: string,
	bundleId: string
): AsyncResult<void> {
	const argv = installArgv(target, appPath, deps.env);
	const res = await deps.exec(argv, { timeoutMs: INSTALL_TIMEOUT_MS });
	// `adb install` can exit 0 while printing `Failure [INSTALL_…]`
	if (res.exitCode !== 0 || /Failure \[/.test(res.stdout)) return err(`install failed: ${execError(argv, res)}`);
	const present = await isAppInstalled(deps, target, bundleId);
	if (!present.success) return present;
	if (!present.data) {
		return err(`installed ${appPath} on ${target.deviceId} but ${bundleId} is not there — wrong bundle id in config?`);
	}
	return ok(undefined);
}
