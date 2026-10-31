import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";
import { androidTools } from "../providers/android";
import type { Platform } from "../types";
import { type DeviceIo, installOnPhone, probePhone, uninstallFromPhone } from "./install-device";
import type { InstalledApp } from "./resolve";

/** Byte size of a file; undefined when it cannot be read. Injected so identity checks need no `stat` spawns. */
export type FileSize = (path: string) => Promise<number | undefined>;

export const nodeFileSize: FileSize = async (path) => {
	try {
		return (await stat(path)).size;
	} catch {
		return undefined;
	}
};

/** Hex sha256 of a file; undefined when it cannot be read (or is a directory). Injected so tests need no real apk. */
export type FileDigest = (path: string) => Promise<string | undefined>;

export const nodeFileDigest: FileDigest = (path) =>
	new Promise((resolve) => {
		const hash = createHash("sha256");
		const stream = createReadStream(path);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", () => resolve(undefined));
		stream.on("end", () => resolve(hash.digest("hex")));
	});

/** `ino:mtime` of a file; undefined when it cannot be read. Injected so tests need no real container. */
export type FileStamp = (path: string) => Promise<string | undefined>;

export const nodeFileStamp: FileStamp = async (path) => {
	try {
		const st = await stat(path);
		return `${st.ino}:${st.mtimeMs}`;
	} catch {
		return undefined;
	}
};

/**
 * `ino:mtime` of an installed `.app`'s executable, guessed as the bundle's own name (`App.app/App`, what
 * Xcode's `EXECUTABLE_NAME` defaults to) so no `plutil` is needed; undefined when that file is not there.
 */
export function executableStamp(container: string, fileStamp: FileStamp = nodeFileStamp): Promise<string | undefined> {
	return fileStamp(join(container, basename(container, ".app")));
}

export type InstallerDeps = {
	exec: Exec;
	env: Record<string, string | undefined>;
	/** default: `node:fs` */
	fileSize?: FileSize;
	/** the temp files of `devicectl` calls on a physical iPhone (default: node:fs) */
	deviceIo?: DeviceIo;
	/** sha256 of the cached apk for the Android identity check (default: `node:fs`) */
	fileDigest?: FileDigest;
};

/** A device to install onto: iOS simulator udid / Android emulator or phone serial. `physical`: a real phone (ABI check before installing). */
export type InstallTarget = { platform: Platform; deviceId: string; physical?: boolean };

const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** A real iPhone / iPad: installed, probed and removed with `devicectl`, not `simctl`. */
export const isPhoneIos = (target: InstallTarget): boolean => target.platform === "ios" && target.physical === true;

const phoneDeps = (deps: InstallerDeps) => ({ exec: deps.exec, ...(deps.deviceIo ? { io: deps.deviceIo } : {}) });

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

/**
 * Is `bundleId` on the device, and (iOS) where is its container? One `simctl get_app_container` /
 * `pm path` — hand the container to `appMatchesArtifact` instead of asking again. simctl exits
 * non-zero / `pm path` prints nothing when the app is not there.
 */
export async function probeApp(
	deps: InstallerDeps,
	target: InstallTarget,
	bundleId: string
): AsyncResult<InstalledApp> {
	if (isPhoneIos(target)) return probePhone(phoneDeps(deps), target.deviceId, bundleId);
	const res = await deps.exec(probeArgv(target, bundleId, deps.env));
	if (target.platform === "ios") {
		const container = res.stdout.trim();
		return ok(res.exitCode === 0 && container !== "" ? { present: true, container } : { present: false });
	}
	return ok({ present: res.exitCode === 0 && res.stdout.includes("package:") });
}

/** Is `bundleId` installed on the device? */
export async function isAppInstalled(
	deps: InstallerDeps,
	target: InstallTarget,
	bundleId: string
): AsyncResult<boolean> {
	const probed = await probeApp(deps, target, bundleId);
	return probed.success ? ok(probed.data.present) : probed;
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
 * cached one. One `plutil` spawn; the sizes are read in-process. undefined when the bundle can't be read.
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
	const size = deps.fileSize ?? nodeFileSize;
	const [exe, js] = await Promise.all([size(`${appDir}/${info.CFBundleExecutable}`), size(`${appDir}/main.jsbundle`)]);
	if (exe === undefined) return undefined;
	return [String(info.CFBundleVersion ?? ""), String(exe), js === undefined ? "-" : String(js)].join("|");
}

/**
 * Is the app on the device the cached `artifactPath` build? iOS: compare `appIdentity` of the
 * installed container with the cached `.app`; pass `installedDir` (the container `probeApp` already
 * found) to skip a second `simctl get_app_container`. Anything unreadable counts as a mismatch
 * (reinstall is the safe side). Android: the sha256 of the installed `base.apk` (`pm path` + the device's
 * `sha256sum`) against the cached apk's. The install record is only a hint, never the proof: an emulator
 * restored from a snapshot, or installed onto by another tool, keeps the record while the app differs.
 */
export async function appMatchesArtifact(
	deps: InstallerDeps,
	target: InstallTarget,
	bundleId: string,
	artifactPath: string,
	installedDir?: string
): AsyncResult<boolean> {
	if (target.platform !== "ios") return androidMatchesArtifact(deps, target, bundleId, artifactPath);
	if (isPhoneIos(target)) return ok(false);
	const installedAt = installedDir ?? (await out(deps, probeArgv(target, bundleId, deps.env)));
	if (!installedAt) return ok(false);
	const [installed, cached] = await Promise.all([appIdentity(deps, installedAt), appIdentity(deps, artifactPath)]);
	return ok(installed !== undefined && installed === cached);
}

/** The installed apk (`pm path` prints one `package:` line per split; the base is first) has the cached apk's digest. */
async function androidMatchesArtifact(
	deps: InstallerDeps,
	target: InstallTarget,
	bundleId: string,
	artifactPath: string
): AsyncResult<boolean> {
	const paths = await out(deps, probeArgv(target, bundleId, deps.env));
	const apk = paths
		?.split("\n")
		.map((line) => line.trim().replace(/^package:/, ""))
		.find((line) => line.endsWith(".apk"));
	if (!apk) return ok(false);
	const [onDevice, cached] = await Promise.all([
		out(deps, [androidTools(deps.env).adb, "-s", target.deviceId, "shell", "sha256sum", apk]),
		(deps.fileDigest ?? nodeFileDigest)(artifactPath),
	]);
	const installed = onDevice?.split(/\s+/)[0];
	return ok(installed !== undefined && installed !== "" && installed === cached);
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
	if (isPhoneIos(target)) {
		const gone = await uninstallFromPhone(phoneDeps(deps), target.deviceId, bundleId);
		if (!gone.success) return gone;
		const left = await isAppInstalled(deps, target, bundleId);
		if (!left.success) return left;
		return left.data ? err(`uninstalled ${bundleId} from ${target.deviceId} but it is still there`) : ok(undefined);
	}
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
	const done = await installAndProbe(deps, target, appPath, bundleId);
	return done.success ? ok(undefined) : done;
}

/** ABI directories under `lib/` in `unzip -Z1` output; empty for a pure-Java APK. */
export function apkAbis(entries: string): string[] {
	const abis = new Set<string>();
	for (const line of entries.split("\n")) {
		const abi = /^lib\/([^/]+)\/./.exec(line.trim())?.[1];
		if (abi) abis.add(abi);
	}
	return [...abis];
}

/**
 * A phone only runs the ABIs in `ro.product.cpu.abilist`. An APK whose `lib/<abi>/` folders share none with them
 * installs and then crashes on launch (`warden e2e` defaults to the `simulator` kind, x86_64 on an Intel host),
 * so it is refused here with the way out. Best effort: an APK or ABI list that cannot be read lets the install go on.
 */
async function abiMismatch(deps: InstallerDeps, target: InstallTarget, appPath: string): Promise<string | undefined> {
	const [listing, props] = await Promise.all([
		deps.exec(["unzip", "-Z1", appPath]),
		deps.exec([androidTools(deps.env).adb, "-s", target.deviceId, "shell", "getprop", "ro.product.cpu.abilist"]),
	]);
	if (listing.exitCode !== 0 || props.exitCode !== 0) return undefined;
	const wanted = apkAbis(listing.stdout);
	const supported = props.stdout
		.trim()
		.split(",")
		.map((abi) => abi.trim())
		.filter((abi) => abi !== "");
	if (wanted.length === 0 || supported.length === 0 || wanted.some((abi) => supported.includes(abi))) return undefined;
	return (
		`abi_mismatch: ${appPath} has native code for ${wanted.join(", ")} but ${target.deviceId} runs ${supported.join(", ")}. ` +
		"Install an arm64 build instead: use the `dev` or `release` build kind (the `simulator` kind targets the host CPU)"
	);
}

/** The reason of an `adb install` failure; a signature clash gets its own message and is never fixed by uninstalling. */
function installFailure(
	argv: string[],
	res: { exitCode: number; stdout: string; stderr: string },
	target: InstallTarget,
	bundleId: string
): string {
	if (target.platform === "android" && /INSTALL_FAILED_UPDATE_INCOMPATIBLE/.test(res.stdout + res.stderr)) {
		return (
			`install failed: a differently-signed copy of ${bundleId} is installed on ${target.deviceId}; ` +
			"uninstall it yourself (warden never uninstalls it for you), then retry"
		);
	}
	return `install failed: ${execError(argv, res)}`;
}

/** `installApp`, keeping what the confirming probe found (iOS: the new bundle container, 17-7). */
export async function installAndProbe(
	deps: InstallerDeps,
	target: InstallTarget,
	appPath: string,
	bundleId: string
): AsyncResult<InstalledApp> {
	if (isPhoneIos(target)) return installOnPhone(phoneDeps(deps), target.deviceId, appPath, bundleId);
	if (target.platform === "android" && target.physical === true) {
		const mismatch = await abiMismatch(deps, target, appPath);
		if (mismatch !== undefined) return err(mismatch);
	}
	const argv = installArgv(target, appPath, deps.env);
	const res = await deps.exec(argv, { timeoutMs: INSTALL_TIMEOUT_MS });
	// `adb install` can exit 0 while printing `Failure [INSTALL_…]`
	if (res.exitCode !== 0 || /Failure \[/.test(res.stdout)) return err(installFailure(argv, res, target, bundleId));
	const present = await probeApp(deps, target, bundleId);
	if (!present.success) return present;
	if (!present.data.present) {
		return err(`installed ${appPath} on ${target.deviceId} but ${bundleId} is not there — wrong bundle id in config?`);
	}
	return present;
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
	if (isPhoneIos(target)) {
		return err("--reset-keychain is for simulators: a phone's keychain is not reset (uninstalling keeps it)");
	}
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
	if (isPhoneIos(target)) {
		return err(
			`app data of ${bundleId} cannot be reset in place on a phone: warden reinstalls it (--install-mode reinstall)`
		);
	}
	const present = await isAppInstalled(deps, target, bundleId);
	if (!present.success) return present;
	if (!present.data) return err(`${bundleId} is not installed on ${target.deviceId}`);
	if (target.platform === "ios") return resetIos(deps, target, bundleId, opts);

	const argv = resetArgv(target, bundleId, deps.env);
	const res = await deps.exec(argv);
	if (res.exitCode !== 0 || !res.stdout.includes("Success")) return err(`pm clear failed: ${execError(argv, res)}`);
	return ok(undefined);
}
