import { mkdir, readdir, rm } from "node:fs/promises";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
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

/** Run `cmd`, stdout trimmed; undefined when it fails. */
async function out(deps: InstallerDeps, cmd: string[]): Promise<string | undefined> {
	const res = await deps.exec(cmd);
	return res.exitCode === 0 ? res.stdout.trim() : undefined;
}

/**
 * What distinguishes one build of an `.app` from another, cheaply: `CFBundleVersion` plus the byte
 * size of the main executable and of the embedded `main.jsbundle` (Release). Size is used instead
 * of mtime because `simctl install` re-copies the bundle, so the installed mtime need not match the
 * cached one. undefined when the bundle can't be read.
 */
export async function appIdentity(deps: InstallerDeps, appDir: string): Promise<string | undefined> {
	const plist = await out(deps, ["plutil", "-convert", "json", "-o", "-", `${appDir}/Info.plist`]);
	if (plist === undefined) return undefined;
	let info: { CFBundleVersion?: unknown; CFBundleExecutable?: unknown };
	try {
		info = JSON.parse(plist) as typeof info;
	} catch {
		return undefined;
	}
	if (typeof info.CFBundleExecutable !== "string") return undefined;
	const exe = await out(deps, ["stat", "-f", "%z", `${appDir}/${info.CFBundleExecutable}`]);
	if (exe === undefined) return undefined;
	const js = await out(deps, ["stat", "-f", "%z", `${appDir}/main.jsbundle`]);
	return [String(info.CFBundleVersion ?? ""), exe, js ?? "-"].join("|");
}

/**
 * Is the app on the device the cached `artifactPath` build? iOS: compare `appIdentity` of the
 * installed container (`simctl get_app_container`) with the cached `.app`. Anything unreadable
 * counts as a mismatch (reinstall is the safe side). Android: not checked (always true) — warden's
 * install record is trusted there.
 */
export async function appMatchesArtifact(
	deps: InstallerDeps,
	target: InstallTarget,
	bundleId: string,
	artifactPath: string
): AsyncResult<boolean> {
	if (target.platform !== "ios") return ok(true);
	const installedDir = await out(deps, probeArgv(target, bundleId, deps.env));
	if (!installedDir) return ok(false);
	const [installed, cached] = await Promise.all([appIdentity(deps, installedDir), appIdentity(deps, artifactPath)]);
	return ok(installed !== undefined && installed === cached);
}

/** `xcrun simctl uninstall <udid> <bundleId>` / `adb -s <serial> uninstall <bundleId>`. */
export function uninstallArgv(target: InstallTarget, bundleId: string, env: InstallerDeps["env"]): string[] {
	return target.platform === "ios"
		? ["xcrun", "simctl", "uninstall", target.deviceId, bundleId]
		: [androidTools(env).adb, "-s", target.deviceId, "uninstall", bundleId];
}

/**
 * Remove `bundleId` (and with it the app container: data, keychain-less state) so the next install
 * starts fresh. Absent already is fine; present after the uninstall is an error.
 */
export async function uninstallApp(deps: InstallerDeps, target: InstallTarget, bundleId: string): AsyncResult<void> {
	const present = await isAppInstalled(deps, target, bundleId);
	if (!present.success) return present;
	if (!present.data) return ok(undefined);
	const argv = uninstallArgv(target, bundleId, deps.env);
	const res = await deps.exec(argv, { timeoutMs: INSTALL_TIMEOUT_MS });
	if (res.exitCode !== 0 || /Failure/.test(res.stdout)) return err(`uninstall failed: ${execError(argv, res)}`);
	const after = await isAppInstalled(deps, target, bundleId);
	if (!after.success) return after;
	return after.data ? err(`uninstalled ${bundleId} from ${target.deviceId} but it is still there`) : ok(undefined);
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

/** Filesystem ops the iOS data wipe needs (injected; tests pass fakes). */
export type ResetFs = {
	readdir: (dir: string) => Promise<string[]>;
	/** Recursive, force. */
	rm: (path: string) => Promise<void>;
	/** Recursive. */
	mkdir: (path: string) => Promise<void>;
};

export type ResetDeps = InstallerDeps & { fs: ResetFs };

export type ResetOptions = { keychain?: boolean };

/** `node:fs/promises`-backed `ResetFs`. */
export const nodeResetFs: ResetFs = {
	readdir: (dir) => readdir(dir),
	rm: (path) => rm(path, { recursive: true, force: true }),
	mkdir: async (path) => {
		await mkdir(path, { recursive: true });
	},
};

/** Kept when wiping a container: simulator-managed, the app is unreachable without it. */
const CONTAINER_METADATA = ".com.apple.mobile_container_manager.metadata.plist";

/** Subdirs apps assume exist in a fresh data container. */
const DATA_SUBDIRS = ["Documents", "Library/Caches", "Library/Preferences", "tmp"];

/**
 * Android: `adb -s <serial> shell pm clear <bundleId>`. iOS: `simctl privacy <udid> reset all <bundleId>`
 * (the last argv-only step of the multi-step iOS reset; see `resetAppData`).
 */
export function resetArgv(target: InstallTarget, bundleId: string, env: InstallerDeps["env"]): string[] {
	return target.platform === "ios"
		? ["xcrun", "simctl", "privacy", target.deviceId, "reset", "all", bundleId]
		: [androidTools(env).adb, "-s", target.deviceId, "shell", "pm", "clear", bundleId];
}

/** Remove every entry of `dir` except the container metadata plist. */
async function wipeDir(fs: ResetFs, dir: string): Promise<void> {
	for (const entry of await fs.readdir(dir)) {
		if (entry !== CONTAINER_METADATA) await fs.rm(`${dir}/${entry}`);
	}
}

/** Wipe the app-group containers listed by `simctl get_app_container <udid> <id> groups` (none is fine). */
async function wipeGroups(deps: ResetDeps, udid: string, bundleId: string): Promise<void> {
	const groups = await deps.exec(["xcrun", "simctl", "get_app_container", udid, bundleId, "groups"]);
	if (groups.exitCode !== 0) return;
	for (const line of groups.stdout.split("\n")) {
		const [, ...rest] = line.trim().split(/\s+/);
		const path = rest.join(" ");
		if (path !== "") await wipeDir(deps.fs, path);
	}
}

/** iOS half of `resetAppData`: terminate, defaults, containers, privacy, optional keychain. */
async function resetIos(
	deps: ResetDeps,
	target: InstallTarget,
	bundleId: string,
	opts: ResetOptions
): AsyncResult<void> {
	const udid = target.deviceId;
	// Not running / no defaults domain yet are fine.
	await deps.exec(["xcrun", "simctl", "terminate", udid, bundleId]);
	await deps.exec(["xcrun", "simctl", "spawn", udid, "defaults", "delete", bundleId]);

	const dataArgv = ["xcrun", "simctl", "get_app_container", udid, bundleId, "data"];
	const data = await deps.exec(dataArgv);
	const dataDir = data.stdout.trim();
	if (data.exitCode !== 0 || dataDir === "") return err(`data container not found: ${execError(dataArgv, data)}`);
	try {
		await wipeDir(deps.fs, dataDir);
		for (const sub of DATA_SUBDIRS) await deps.fs.mkdir(`${dataDir}/${sub}`);
		await wipeGroups(deps, udid, bundleId);
	} catch (e) {
		return err(`wiping app data failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	const privacy = resetArgv(target, bundleId, deps.env);
	const priv = await deps.exec(privacy);
	if (priv.exitCode !== 0) return err(`privacy reset failed: ${execError(privacy, priv)}`);

	return opts.keychain ? resetSimKeychain(deps, target) : ok(undefined);
}

/** iOS: `simctl keychain <udid> reset` (the whole simulator's keychain; an uninstall leaves it). Android: nothing. */
export async function resetSimKeychain(deps: InstallerDeps, target: InstallTarget): AsyncResult<void> {
	if (target.platform !== "ios") return ok(undefined);
	const argv = ["xcrun", "simctl", "keychain", target.deviceId, "reset"];
	const res = await deps.exec(argv);
	return res.exitCode === 0 ? ok(undefined) : err(`keychain reset failed: ${execError(argv, res)}`);
}

/**
 * Reset an installed app to first-launch state without reinstalling. Not installed → error (the
 * caller installs instead). Android: `pm clear` (data, permissions; keychain n/a). iOS: terminate,
 * `defaults delete` (via cfprefsd; deleting the plist alone is undone by its cache), wipe the data
 * and app-group containers in place (the metadata plist stays), recreate the standard subdirs,
 * reset privacy grants, and with `keychain` the simulator-wide keychain.
 */
export async function resetAppData(
	deps: ResetDeps,
	target: InstallTarget,
	bundleId: string,
	opts: ResetOptions = {}
): AsyncResult<void> {
	const present = await isAppInstalled(deps, target, bundleId);
	if (!present.success) return present;
	if (!present.data) return err(`${bundleId} is not installed on ${target.deviceId}`);
	if (target.platform === "ios") return resetIos(deps, target, bundleId, opts);

	const argv = resetArgv(target, bundleId, deps.env);
	const res = await deps.exec(argv);
	if (res.exitCode !== 0 || !res.stdout.includes("Success")) return err(`pm clear failed: ${execError(argv, res)}`);
	return ok(undefined);
}
