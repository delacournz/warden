import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import { type Exec, execErrors } from "@delacour/warden-runtime/exec";
import type { Platform } from "@delacour/warden-store/types";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { type DeviceIo, installDevice } from "./install-device";
import type { InstalledApp } from "./resolve";

/** Byte size of a file; undefined when it cannot be read. Injected so identity checks need no `stat` spawns. */
export type FileSize = (path: string) => Promise<number | undefined>;

/** Hex sha256 of a file; undefined when it cannot be read (or is a directory). Injected so tests need no real apk. */
export type FileDigest = (path: string) => Promise<string | undefined>;

/** `ino:mtime` of a file; undefined when it cannot be read. Injected so tests need no real container. */
export type FileStamp = (path: string) => Promise<string | undefined>;

/** Real-filesystem `FileSize` / `FileDigest` / `FileStamp` readers (the defaults of `InstallerDeps`). */
export class NodeFiles {
	readonly size: FileSize = async (path) => {
		try {
			return (await stat(path)).size;
		} catch {
			return undefined;
		}
	};

	readonly digest: FileDigest = (path) =>
		new Promise((resolve) => {
			const hash = createHash("sha256");
			const stream = createReadStream(path);
			stream.on("data", (chunk) => hash.update(chunk));
			stream.on("error", () => resolve(undefined));
			stream.on("end", () => resolve(hash.digest("hex")));
		});

	readonly stamp: FileStamp = async (path) => {
		try {
			const st = await stat(path);
			return `${st.ino}:${st.mtimeMs}`;
		} catch {
			return undefined;
		}
	};
}

export const nodeFiles = new NodeFiles();

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
 * Install, probe, uninstall and reset apps on a device. Stateless: every method takes its deps
 * (`exec`, `env`, injected fs readers) per call.
 */
export class Installer {
	/** A real iPhone / iPad: installed, probed and removed with `devicectl`, not `simctl`. */
	isPhoneIos(target: InstallTarget): boolean {
		return target.platform === "ios" && target.physical === true;
	}

	private phoneDeps(deps: InstallerDeps): { exec: Exec; io?: DeviceIo } {
		return { exec: deps.exec, ...(deps.deviceIo ? { io: deps.deviceIo } : {}) };
	}

	/**
	 * `ino:mtime` of an installed `.app`'s executable, guessed as the bundle's own name (`App.app/App`, what
	 * Xcode's `EXECUTABLE_NAME` defaults to) so no `plutil` is needed; undefined when that file is not there.
	 */
	executableStamp(container: string, fileStamp: FileStamp = nodeFiles.stamp): Promise<string | undefined> {
		return fileStamp(join(container, basename(container, ".app")));
	}

	/** `xcrun simctl install <udid> <app>` / `adb -s <serial> install -r <apk>`. */
	installArgv(target: InstallTarget, appPath: string, env: InstallerDeps["env"]): string[] {
		return target.platform === "ios"
			? ["xcrun", "simctl", "install", target.deviceId, appPath]
			: [androidToolsLocator.locate(env).adb, "-s", target.deviceId, "install", "-r", appPath];
	}

	/** `xcrun simctl get_app_container <udid> <bundleId>` / `adb -s <serial> shell pm path <bundleId>`. */
	probeArgv(target: InstallTarget, bundleId: string, env: InstallerDeps["env"]): string[] {
		return target.platform === "ios"
			? ["xcrun", "simctl", "get_app_container", target.deviceId, bundleId]
			: [androidToolsLocator.locate(env).adb, "-s", target.deviceId, "shell", "pm", "path", bundleId];
	}

	/**
	 * Is `bundleId` on the device, and (iOS) where is its container? One `simctl get_app_container` /
	 * `pm path` — hand the container to `appMatchesArtifact` instead of asking again. simctl exits
	 * non-zero / `pm path` prints nothing when the app is not there.
	 */
	async probe(deps: InstallerDeps, target: InstallTarget, bundleId: string): AsyncResult<InstalledApp> {
		if (this.isPhoneIos(target)) return installDevice.probe(this.phoneDeps(deps), target.deviceId, bundleId);
		const res = await deps.exec(this.probeArgv(target, bundleId, deps.env));
		if (target.platform === "ios") {
			const container = res.stdout.trim();
			return resultFactory.ok(
				res.exitCode === 0 && container !== "" ? { present: true, container } : { present: false }
			);
		}
		return resultFactory.ok({ present: res.exitCode === 0 && res.stdout.includes("package:") });
	}

	/** Is `bundleId` installed on the device? */
	async isInstalled(deps: InstallerDeps, target: InstallTarget, bundleId: string): AsyncResult<boolean> {
		const probed = await this.probe(deps, target, bundleId);
		return probed.success ? resultFactory.ok(probed.data.present) : probed;
	}

	/** Run `cmd`, stdout trimmed; undefined when it fails. */
	private async out(deps: InstallerDeps, cmd: string[]): Promise<string | undefined> {
		const res = await deps.exec(cmd);
		return res.exitCode === 0 ? res.stdout.trim() : undefined;
	}

	/**
	 * What distinguishes one build of an `.app` from another, cheaply: `CFBundleVersion` plus the byte
	 * size of the main executable and of the embedded `main.jsbundle` (Release). Size is used instead
	 * of mtime because `simctl install` re-copies the bundle, so the installed mtime need not match the
	 * cached one. One `plutil` spawn; the sizes are read in-process. undefined when the bundle can't be read.
	 */
	async appIdentity(deps: InstallerDeps, appDir: string): Promise<string | undefined> {
		const plist = await this.out(deps, ["plutil", "-convert", "json", "-o", "-", `${appDir}/Info.plist`]);
		if (plist === undefined) return undefined;
		let info: { CFBundleVersion?: unknown; CFBundleExecutable?: unknown };
		try {
			info = JSON.parse(plist) as typeof info;
		} catch {
			return undefined;
		}
		if (typeof info.CFBundleExecutable !== "string") return undefined;
		const size = deps.fileSize ?? nodeFiles.size;
		const [exe, js] = await Promise.all([
			size(`${appDir}/${info.CFBundleExecutable}`),
			size(`${appDir}/main.jsbundle`),
		]);
		if (exe === undefined) return undefined;
		return [String(info.CFBundleVersion ?? ""), String(exe), js === undefined ? "-" : String(js)].join("|");
	}

	/**
	 * Is the app on the device the cached `artifactPath` build? iOS: compare `appIdentity` of the
	 * installed container with the cached `.app`; pass `installedDir` (the container `probe` already
	 * found) to skip a second `simctl get_app_container`. Anything unreadable counts as a mismatch
	 * (reinstall is the safe side). Android: the sha256 of the installed `base.apk` (`pm path` + the device's
	 * `sha256sum`) against the cached apk's. The install record is only a hint, never the proof: an emulator
	 * restored from a snapshot, or installed onto by another tool, keeps the record while the app differs.
	 */
	async appMatchesArtifact(
		deps: InstallerDeps,
		target: InstallTarget,
		bundleId: string,
		artifactPath: string,
		installedDir?: string
	): AsyncResult<boolean> {
		if (target.platform !== "ios") return this.androidMatchesArtifact(deps, target, bundleId, artifactPath);
		if (this.isPhoneIos(target)) return resultFactory.ok(false);
		const installedAt = installedDir ?? (await this.out(deps, this.probeArgv(target, bundleId, deps.env)));
		if (!installedAt) return resultFactory.ok(false);
		const [installed, cached] = await Promise.all([
			this.appIdentity(deps, installedAt),
			this.appIdentity(deps, artifactPath),
		]);
		return resultFactory.ok(installed !== undefined && installed === cached);
	}

	/** The installed apk (`pm path` prints one `package:` line per split; the base is first) has the cached apk's digest. */
	private async androidMatchesArtifact(
		deps: InstallerDeps,
		target: InstallTarget,
		bundleId: string,
		artifactPath: string
	): AsyncResult<boolean> {
		const paths = await this.out(deps, this.probeArgv(target, bundleId, deps.env));
		const apk = paths
			?.split("\n")
			.map((line) => line.trim().replace(/^package:/, ""))
			.find((line) => line.endsWith(".apk"));
		if (!apk) return resultFactory.ok(false);
		const [onDevice, cached] = await Promise.all([
			this.out(deps, [androidToolsLocator.locate(deps.env).adb, "-s", target.deviceId, "shell", "sha256sum", apk]),
			(deps.fileDigest ?? nodeFiles.digest)(artifactPath),
		]);
		const installed = onDevice?.split(/\s+/)[0];
		return resultFactory.ok(installed !== undefined && installed !== "" && installed === cached);
	}

	/** `xcrun simctl uninstall <udid> <bundleId>` / `adb -s <serial> uninstall <bundleId>`. */
	uninstallArgv(target: InstallTarget, bundleId: string, env: InstallerDeps["env"]): string[] {
		return target.platform === "ios"
			? ["xcrun", "simctl", "uninstall", target.deviceId, bundleId]
			: [androidToolsLocator.locate(env).adb, "-s", target.deviceId, "uninstall", bundleId];
	}

	/**
	 * Remove `bundleId` (and with it the app container: data, keychain-less state) so the next install
	 * starts fresh. Absent already is fine; present after the uninstall is an error.
	 */
	async uninstall(deps: InstallerDeps, target: InstallTarget, bundleId: string): AsyncResult<void> {
		const present = await this.isInstalled(deps, target, bundleId);
		if (!present.success) return present;
		if (!present.data) return resultFactory.ok(undefined);
		if (this.isPhoneIos(target)) {
			const gone = await installDevice.uninstall(this.phoneDeps(deps), target.deviceId, bundleId);
			if (!gone.success) return gone;
			const left = await this.isInstalled(deps, target, bundleId);
			if (!left.success) return left;
			return left.data
				? resultFactory.err(`uninstalled ${bundleId} from ${target.deviceId} but it is still there`)
				: resultFactory.ok(undefined);
		}
		const argv = this.uninstallArgv(target, bundleId, deps.env);
		const res = await deps.exec(argv, { timeoutMs: INSTALL_TIMEOUT_MS });
		if (res.exitCode !== 0 || /Failure/.test(res.stdout))
			return resultFactory.err(`uninstall failed: ${execErrors.format(argv, res)}`);
		const after = await this.isInstalled(deps, target, bundleId);
		if (!after.success) return after;
		return after.data
			? resultFactory.err(`uninstalled ${bundleId} from ${target.deviceId} but it is still there`)
			: resultFactory.ok(undefined);
	}

	/** Install `appPath`, then confirm `bundleId` is present. */
	async install(deps: InstallerDeps, target: InstallTarget, appPath: string, bundleId: string): AsyncResult<void> {
		const done = await this.installAndProbe(deps, target, appPath, bundleId);
		return done.success ? resultFactory.ok(undefined) : done;
	}

	/** ABI directories under `lib/` in `unzip -Z1` output; empty for a pure-Java APK. */
	apkAbis(entries: string): string[] {
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
	private async abiMismatch(deps: InstallerDeps, target: InstallTarget, appPath: string): Promise<string | undefined> {
		const [listing, props] = await Promise.all([
			deps.exec(["unzip", "-Z1", appPath]),
			deps.exec([
				androidToolsLocator.locate(deps.env).adb,
				"-s",
				target.deviceId,
				"shell",
				"getprop",
				"ro.product.cpu.abilist",
			]),
		]);
		if (listing.exitCode !== 0 || props.exitCode !== 0) return undefined;
		const wanted = this.apkAbis(listing.stdout);
		const supported = props.stdout
			.trim()
			.split(",")
			.map((abi) => abi.trim())
			.filter((abi) => abi !== "");
		if (wanted.length === 0 || supported.length === 0 || wanted.some((abi) => supported.includes(abi)))
			return undefined;
		return (
			`abi_mismatch: ${appPath} has native code for ${wanted.join(", ")} but ${target.deviceId} runs ${supported.join(", ")}. ` +
			"Install an arm64 build instead: use the `dev` or `release` build kind (the `simulator` kind targets the host CPU)"
		);
	}

	/** The reason of an `adb install` failure; a signature clash gets its own message and is never fixed by uninstalling. */
	private installFailure(
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
		return `install failed: ${execErrors.format(argv, res)}`;
	}

	/** `install`, keeping what the confirming probe found (iOS: the new bundle container, 17-7). */
	async installAndProbe(
		deps: InstallerDeps,
		target: InstallTarget,
		appPath: string,
		bundleId: string
	): AsyncResult<InstalledApp> {
		if (this.isPhoneIos(target)) return installDevice.install(this.phoneDeps(deps), target.deviceId, appPath, bundleId);
		if (target.platform === "android" && target.physical === true) {
			const mismatch = await this.abiMismatch(deps, target, appPath);
			if (mismatch !== undefined) return resultFactory.err(mismatch);
		}
		const argv = this.installArgv(target, appPath, deps.env);
		const res = await deps.exec(argv, { timeoutMs: INSTALL_TIMEOUT_MS });
		// `adb install` can exit 0 while printing `Failure [INSTALL_…]`
		if (res.exitCode !== 0 || /Failure \[/.test(res.stdout))
			return resultFactory.err(this.installFailure(argv, res, target, bundleId));
		const present = await this.probe(deps, target, bundleId);
		if (!present.success) return present;
		if (!present.data.present) {
			return resultFactory.err(
				`installed ${appPath} on ${target.deviceId} but ${bundleId} is not there — wrong bundle id in config?`
			);
		}
		return present;
	}

	/**
	 * Android: `adb -s <serial> shell pm clear <bundleId>`. iOS: `simctl privacy <udid> reset all <bundleId>`
	 * (the last argv-only step of the multi-step iOS reset; see `resetAppData`).
	 */
	resetArgv(target: InstallTarget, bundleId: string, env: InstallerDeps["env"]): string[] {
		return target.platform === "ios"
			? ["xcrun", "simctl", "privacy", target.deviceId, "reset", "all", bundleId]
			: [androidToolsLocator.locate(env).adb, "-s", target.deviceId, "shell", "pm", "clear", bundleId];
	}

	/** Remove every entry of `dir` except the container metadata plist. */
	private async wipeDir(fs: ResetFs, dir: string): Promise<void> {
		for (const entry of await fs.readdir(dir)) {
			if (entry !== CONTAINER_METADATA) await fs.rm(`${dir}/${entry}`);
		}
	}

	/** Wipe the app-group containers listed by `simctl get_app_container <udid> <id> groups` (none is fine). */
	private async wipeGroups(deps: ResetDeps, udid: string, bundleId: string): Promise<void> {
		const groups = await deps.exec(["xcrun", "simctl", "get_app_container", udid, bundleId, "groups"]);
		if (groups.exitCode !== 0) return;
		for (const line of groups.stdout.split("\n")) {
			const [, ...rest] = line.trim().split(/\s+/);
			const path = rest.join(" ");
			if (path !== "") await this.wipeDir(deps.fs, path);
		}
	}

	/** iOS half of `resetAppData`: terminate, defaults, containers, privacy, optional keychain. */
	private async resetIos(
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
		if (data.exitCode !== 0 || dataDir === "")
			return resultFactory.err(`data container not found: ${execErrors.format(dataArgv, data)}`);
		try {
			await this.wipeDir(deps.fs, dataDir);
			for (const sub of DATA_SUBDIRS) await deps.fs.mkdir(`${dataDir}/${sub}`);
			await this.wipeGroups(deps, udid, bundleId);
		} catch (e) {
			return resultFactory.err(`wiping app data failed: ${e instanceof Error ? e.message : String(e)}`);
		}

		const privacy = this.resetArgv(target, bundleId, deps.env);
		const priv = await deps.exec(privacy);
		if (priv.exitCode !== 0) return resultFactory.err(`privacy reset failed: ${execErrors.format(privacy, priv)}`);

		return opts.keychain ? this.resetSimKeychain(deps, target) : resultFactory.ok(undefined);
	}

	/** iOS: `simctl keychain <udid> reset` (the whole simulator's keychain; an uninstall leaves it). Android: nothing. */
	async resetSimKeychain(deps: InstallerDeps, target: InstallTarget): AsyncResult<void> {
		if (target.platform !== "ios") return resultFactory.ok(undefined);
		if (this.isPhoneIos(target)) {
			return resultFactory.err(
				"--reset-keychain is for simulators: a phone's keychain is not reset (uninstalling keeps it)"
			);
		}
		const argv = ["xcrun", "simctl", "keychain", target.deviceId, "reset"];
		const res = await deps.exec(argv);
		return res.exitCode === 0
			? resultFactory.ok(undefined)
			: resultFactory.err(`keychain reset failed: ${execErrors.format(argv, res)}`);
	}

	/**
	 * Reset an installed app to first-launch state without reinstalling. Not installed → error (the
	 * caller installs instead). Android: `pm clear` (data, permissions; keychain n/a). iOS: terminate,
	 * `defaults delete` (via cfprefsd; deleting the plist alone is undone by its cache), wipe the data
	 * and app-group containers in place (the metadata plist stays), recreate the standard subdirs,
	 * reset privacy grants, and with `keychain` the simulator-wide keychain.
	 */
	async resetAppData(
		deps: ResetDeps,
		target: InstallTarget,
		bundleId: string,
		opts: ResetOptions = {}
	): AsyncResult<void> {
		if (this.isPhoneIos(target)) {
			return resultFactory.err(
				`app data of ${bundleId} cannot be reset in place on a phone: warden reinstalls it (--install-mode reinstall)`
			);
		}
		const present = await this.isInstalled(deps, target, bundleId);
		if (!present.success) return present;
		if (!present.data) return resultFactory.err(`${bundleId} is not installed on ${target.deviceId}`);
		if (target.platform === "ios") return this.resetIos(deps, target, bundleId, opts);

		const argv = this.resetArgv(target, bundleId, deps.env);
		const res = await deps.exec(argv);
		if (res.exitCode !== 0 || !res.stdout.includes("Success"))
			return resultFactory.err(`pm clear failed: ${execErrors.format(argv, res)}`);
		return resultFactory.ok(undefined);
	}
}

export const installer = new Installer();
