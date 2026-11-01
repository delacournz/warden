/**
 * Android golden: one warden-owned quick-boot snapshot (`warden-<key>`) per AVD, saved from a writable,
 * cold-booted, settled run of that AVD. Claims launch `-read-only -snapshot warden-<key>` when it exists
 * instead of whatever `default_boot` the user's last writable run (Android Studio) left behind, so boot
 * time and start state no longer depend on it. A claim never builds it: a claim that finds it missing
 * cold-boots as before and marks the AVD pending; `warden gc` (one AVD per pass, when no instance of it
 * runs, never under `CI`) or `warden golden ensure --platform android` builds it. Mirrors `ios-golden.ts`:
 * all work on one AVD's snapshots runs under the machine-wide `golden:android:<avd>` build lease.
 *
 * The key covers what makes a snapshot unloadable or different: the system image revision and build
 * fingerprint, the emulator version, the AVD's `hw.*` and guest-shaping config, the launch flags and the
 * recipe. A key change leaves the old snapshot stale; the next build of that AVD (or `warden golden prune
 * --platform android`) deletes it. A snapshot a claim saw fail to load is deleted so the next build replaces it.
 *
 * A biometrics target (`<avd>+bio`, see `biometrics.ts`) is its own snapshot of the same AVD: its key covers
 * `hw.fingerprint=yes` plus a biometrics marker, its build enrolls a fingerprint before saving (so claims start
 * enrolled), and a plain build never deletes it (nor the reverse). Bookkeeping (pending, load failures) is
 * keyed by the target; the build lock, the AVD dir and the emulator are the real AVD's.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { buildLock } from "@delacour/warden-builds/lock";
import {
	Adb,
	type AdbEmulator,
	BootWaiter,
	ConsolePortLeaser,
	DetachedSpawner,
	EMU_CONSOLE_TIMEOUT_MS,
	emulatorArgv,
	GOLDEN_PORT_LABEL,
	LIST_AVDS_TIMEOUT_MS,
	type SpawnDetached,
} from "@delacour/warden-providers/android";
import { AndroidKeyguard } from "@delacour/warden-providers/android-keyguard";
import { androidToolsLocator } from "@delacour/warden-providers/android-tools";
import { biometricProfiles } from "@delacour/warden-providers/biometrics";
import type { Exec } from "@delacour/warden-runtime/exec";
import type { PidAlive } from "@delacour/warden-store/liveness";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import type { Owner } from "@delacour/warden-store/types";
import { leaseModel } from "@delacour/warden-store/types";
import { wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { FingerprintEnroller } from "./android-biometrics";
import {
	ANDROID_SNAPSHOT_MAX_LOAD_FAILURES,
	ANDROID_SNAPSHOT_RETRY_MS,
	AndroidSnapshotPending,
} from "./android-snapshot-pending";

/** Bump when what building a snapshot does to the device changes, so existing snapshots go stale. */
export const ANDROID_SNAPSHOT_RECIPE = 1;
/** Bumped when what a biometrics snapshot is saved in changes. 2: saved past the lock screen, screen kept awake. */
export const ANDROID_BIOMETRICS_RECIPE = 2;
export const ANDROID_SNAPSHOT_PREFIX = "warden-";
const SNAPSHOT_PATTERN = /^warden-[0-9a-f]{10}$/;

export type AndroidSnapshotInputs = {
	/** system image `source.properties` `Pkg.Revision` */
	imageRevision: string;
	/** system image `build.prop` `ro.build.fingerprint` ("" when the image ships none) */
	fingerprint: string;
	/** emulator `source.properties` `Pkg.Revision`, else `emulator -version` */
	emulatorVersion: string;
	/** the AVD `config.ini` lines that shape the guest: `hw.*`, `image.sysdir.*` and `KEYED_CONFIG` */
	hardware: string[];
	/** `headlessEmulatorFlags` the snapshot is built and launched with */
	flags?: string[];
	/** a biometrics snapshot: the build enrolls a fingerprint (absent = plain) */
	biometrics?: boolean;
};

/** Non-`hw.*` `config.ini` keys that change the guest a snapshot captures (`fastboot.*`, display names do not). */
const KEYED_CONFIG =
	/^(hw\.|image\.sysdir\.|abi\.type$|tag\.ids?$|PlayStore\.enabled$|disk\.dataPartition\.size$|sdcard\.(size|path)$|vm\.heapSize$|target$)/;

const SNAPSHOT_ENV_VALUES: Record<string, boolean> = {
	"0": false,
	"1": true,
	false: false,
	true: true,
	off: false,
	on: true,
	no: false,
	yes: true,
};

/** Pure half of the Android golden: snapshot keys and names, `config.ini` parsing, AVD directories. */
export class AndroidSnapshotModel {
	lockKey(avd: string): string {
		return `golden:android:${avd}`;
	}

	name(key: string): string {
		return `${ANDROID_SNAPSHOT_PREFIX}${key}`;
	}

	isWarden(name: string): boolean {
		return SNAPSHOT_PATTERN.test(name);
	}

	/** 10 hex chars of sha256 over everything that makes one snapshot unusable for another. */
	key(inputs: AndroidSnapshotInputs, recipe: number = ANDROID_SNAPSHOT_RECIPE): string {
		const material = [
			inputs.imageRevision,
			inputs.fingerprint,
			inputs.emulatorVersion,
			...[...inputs.hardware].sort(),
			...(inputs.flags !== undefined ? [`flags:${inputs.flags.join(" ")}`] : []),
			...(inputs.biometrics ? [`biometrics:${ANDROID_BIOMETRICS_RECIPE}`] : []),
			`r${recipe}`,
		].join("|");
		return new Bun.CryptoHasher("sha256").update(material).digest("hex").slice(0, 10);
	}

	/** `key=value` lines (`source.properties`, `config.ini`, `build.prop`, `<avd>.ini`). */
	parseProperties(text: string): Map<string, string> {
		const props = new Map<string, string>();
		for (const line of text.split("\n")) {
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#")) continue;
			const eq = trimmed.indexOf("=");
			if (eq <= 0) continue;
			props.set(trimmed.slice(0, eq).trim(), trimmed.slice(eq + 1).trim());
		}
		return props;
	}

	/** `Android emulator version 35.4.9.0 (build_id …)` → `35.4.9.0`. */
	parseEmulatorVersion(stdout: string): string | undefined {
		return /emulator version (\S+)/i.exec(stdout)?.[1];
	}

	/**
	 * `WARDEN_ANDROID_SNAPSHOT` when it says on or off (0/1/true/false/on/off/yes/no, any case); unset or
	 * empty → `undefined`, anything else → `warn(value)` and `undefined`, so the config decides.
	 */
	explicit(env: Record<string, string | undefined>, warn?: (value: string) => void): boolean | undefined {
		const value = env.WARDEN_ANDROID_SNAPSHOT?.trim();
		if (value === undefined || value === "") return undefined;
		const parsed = SNAPSHOT_ENV_VALUES[value.toLowerCase()];
		if (parsed === undefined) warn?.(value);
		return parsed;
	}

	/** On unless `WARDEN_ANDROID_SNAPSHOT` is off; an explicit on wins over a config `android.snapshot: false`. */
	enabled(env: Record<string, string | undefined>, configured?: boolean): boolean {
		return this.explicit(env) ?? configured !== false;
	}

	/**
	 * Where AVDs live, in the emulator's order: `$ANDROID_AVD_HOME`, `$ANDROID_EMULATOR_HOME/avd`,
	 * `$ANDROID_USER_HOME/avd`, `$ANDROID_SDK_HOME/.android/avd`, else `~/.android/avd`.
	 */
	avdHome(env: Record<string, string | undefined>): string {
		if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
		if (env.ANDROID_EMULATOR_HOME) return join(env.ANDROID_EMULATOR_HOME, "avd");
		if (env.ANDROID_USER_HOME) return join(env.ANDROID_USER_HOME, "avd");
		if (env.ANDROID_SDK_HOME) return join(env.ANDROID_SDK_HOME, ".android", "avd");
		return join(env.HOME || homedir(), ".android", "avd");
	}

	/** The AVD's content dir: `path=` of `<home>/<avd>.ini`, else `<home>/<avd>.avd`. */
	avdDir(env: Record<string, string | undefined>, avd: string): string {
		const home = this.avdHome(env);
		const ini = this.readText(join(home, `${avd}.ini`));
		const path = ini !== undefined ? this.parseProperties(ini).get("path") : undefined;
		return path !== undefined && path !== "" ? path : join(home, `${avd}.avd`);
	}

	/** `config.ini` text with `hw.fingerprint=yes` (the emulator has no fingerprint sensor without it). */
	withFingerprintHardware(configText: string): string {
		const lines = configText.split("\n");
		const at = lines.findIndex((l) => /^hw\.fingerprint\s*=/.test(l.trim()));
		if (at >= 0) lines[at] = "hw.fingerprint=yes";
		else {
			if (lines.at(-1) === "") lines.pop();
			lines.push("hw.fingerprint=yes", "");
		}
		return lines.join("\n");
	}

	/** The `--profile` slug naming `target` (`pixel-10`, or `pixel-10+bio`). */
	targetProfile(target: string): string {
		const { profile, biometrics } = biometricProfiles.split(target);
		return biometricProfiles.profile(leaseModel.profileSlug(profile), biometrics);
	}

	/** Both snapshot targets of one AVD: its plain snapshot and its biometrics one. */
	targetsOf(avd: string): string[] {
		return [avd, biometricProfiles.profile(avd, true)];
	}

	snapshotDir(dir: string, name: string): string {
		return join(dir, "snapshots", name);
	}

	/** `snapshot.pb` is the snapshot's metadata, written once a save completes. */
	complete(dir: string, name: string): boolean {
		return existsSync(join(this.snapshotDir(dir, name), "snapshot.pb"));
	}

	/** Warden snapshots in an AVD dir (`snapshots/warden-<10 hex>`). */
	wardenSnapshots(dir: string): string[] {
		try {
			return readdirSync(join(dir, "snapshots"))
				.filter((name) => this.isWarden(name))
				.sort();
		} catch {
			return [];
		}
	}

	readText(path: string): string | undefined {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return undefined;
		}
	}
}

export const androidSnapshotModel = new AndroidSnapshotModel();

export type AndroidGoldenTiming = {
	/** cold boot of the writable build instance */
	bootTimeoutMs: number;
	/** after `boot_completed`: let first-boot work (dexopt, package scans) finish before saving */
	settleMs: number;
	saveTimeoutMs: number;
	/** after `emu kill`: how long to wait for the process to exit before a SIGKILL */
	exitTimeoutMs: number;
	/** after the SIGKILL: how long to wait for it to take */
	killGraceMs: number;
	exitPollMs: number;
	lockWaitMs: number;
};

export const DEFAULT_ANDROID_GOLDEN_TIMING: AndroidGoldenTiming = {
	bootTimeoutMs: 10 * 60_000,
	settleMs: 20_000,
	saveTimeoutMs: 3 * 60_000,
	exitTimeoutMs: 60_000,
	killGraceMs: 5_000,
	exitPollMs: 500,
	lockWaitMs: 20 * 60_000,
};

export type AndroidGoldenDeps = {
	exec: Exec;
	store: Store;
	owner: Owner;
	/** pid recorded on the golden lock */
	pid: number;
	env: Record<string, string | undefined>;
	now: () => number;
	pidAlive: PidAlive;
	sleep: (ms: number) => Promise<void>;
	log?: (line: string) => void;
	/** launches the writable build instance (default: detached `spawn`) */
	spawnDetached?: SpawnDetached;
	/** signals a build emulator warden launched (default: `process.kill`) */
	kill?: (pid: number, signal: "SIGKILL") => void;
	/** a claim is waiting on this build: say how to prewarm it */
	prewarmHint?: boolean;
	timing?: Partial<AndroidGoldenTiming>;
};

export type EnsuredSnapshot = { avd: string; name: string; key: string; built: boolean };
export type AndroidSnapshotEntry = { avd: string; name: string; path: string; current: boolean };

export type SnapshotPass = {
	built?: EnsuredSnapshot;
	failed?: { avd: string; error: string };
	/** pending AVDs left for a later pass because an instance of them runs */
	busy: string[];
};

/** Processes (per `exec`, so once per CLI process) already told there is no SDK root. */
const toldNoSdk = new WeakSet<Exec>();

/** Android quick-boot snapshots: read the key inputs, build, ensure, invalidate, list and prune. */
export class AndroidGolden {
	private readonly pending: AndroidSnapshotPending;

	constructor(private readonly deps: AndroidGoldenDeps) {
		this.pending = new AndroidSnapshotPending(deps.store);
	}

	/**
	 * The key inputs of `avd`, from files only in the common case (no spawn). `undefined` = no SDK root
	 * (`ANDROID_HOME` / `ANDROID_SDK_ROOT` unset): warden cannot find the system image, so no snapshot
	 * (said once per process).
	 */
	async readInputs(
		target: string,
		opts: { writeConfig?: boolean } = {}
	): AsyncResult<{ inputs: AndroidSnapshotInputs; dir: string } | undefined> {
		const { deps } = this;
		const model = androidSnapshotModel;
		const { profile: avd, biometrics } = biometricProfiles.split(target);
		const sdk = deps.env.ANDROID_HOME || deps.env.ANDROID_SDK_ROOT;
		if (!sdk) {
			if (!toldNoSdk.has(deps.exec)) {
				toldNoSdk.add(deps.exec);
				this.log("ANDROID_HOME / ANDROID_SDK_ROOT unset: no quick-boot snapshots, emulators cold-boot");
			}
			return resultFactory.ok(undefined);
		}
		const dir = model.avdDir(deps.env, avd);
		const configText = model.readText(join(dir, "config.ini"));
		if (configText === undefined) return resultFactory.err(`no config.ini in ${dir}`);
		const patched = biometrics
			? this.biometricConfig(dir, configText, opts.writeConfig === true)
			: resultFactory.ok(configText);
		if (!patched.success) return patched;
		const config = model.parseProperties(patched.data);
		const sysdir = config.get("image.sysdir.1");
		if (!sysdir) return resultFactory.err(`${join(dir, "config.ini")} names no image.sysdir.1`);
		const imageDir = isAbsolute(sysdir) ? sysdir : join(sdk, sysdir);
		const source = model.readText(join(imageDir, "source.properties"));
		const imageRevision = source !== undefined ? model.parseProperties(source).get("Pkg.Revision") : undefined;
		if (!imageRevision) return resultFactory.err(`no Pkg.Revision in ${join(imageDir, "source.properties")}`);
		const buildProp = model.parseProperties(model.readText(join(imageDir, "build.prop")) ?? "");
		const fingerprint = buildProp.get("ro.build.fingerprint") ?? buildProp.get("ro.system.build.fingerprint") ?? "";
		const version = await this.emulatorVersion(sdk);
		if (!version.success) return version;
		const hardware = [...config].filter(([k]) => KEYED_CONFIG.test(k)).map(([k, v]) => `${k}=${v}`);
		const flags = emulatorArgv.headlessFlags(deps.env);
		return resultFactory.ok({
			inputs: {
				imageRevision,
				fingerprint,
				emulatorVersion: version.data,
				hardware,
				flags,
				...(biometrics ? { biometrics } : {}),
			},
			dir,
		});
	}

	/**
	 * Warden's current snapshot of `target` (an AVD, or `<avd>+bio`) and whether it exists; files only, no lock.
	 * `undefined` = no SDK root. A biometrics target writes `hw.fingerprint=yes` into the AVD's `config.ini` when it lacks it.
	 */
	async current(
		avd: string
	): AsyncResult<{ avd: string; name: string; key: string; dir: string; present: boolean } | undefined> {
		const read = await this.readInputs(avd, { writeConfig: true });
		if (!read.success || read.data === undefined) return read.success ? resultFactory.ok(undefined) : read;
		const { dir, inputs } = read.data;
		const key = androidSnapshotModel.key(inputs);
		const name = androidSnapshotModel.name(key);
		return resultFactory.ok({ avd, name, key, dir, present: androidSnapshotModel.complete(dir, name) });
	}

	/**
	 * What a claim launches `avd` from: warden's current snapshot when it exists. Missing → `undefined`
	 * (the claim cold-boots read-only as before), one log line, and the AVD is marked for `warden gc` to build.
	 */
	async forClaim(avd: string): AsyncResult<string | undefined> {
		const current = await this.current(avd);
		if (!current.success || current.data === undefined) return current.success ? resultFactory.ok(undefined) : current;
		if (current.data.present) return resultFactory.ok(current.data.name);
		this.pending.markPending(avd);
		this.log(
			`no quick-boot snapshot of ${avd} yet: cold boot (warden gc builds it while ${avd} is idle; now: warden golden ensure --platform android --profile ${androidSnapshotModel.targetProfile(avd)})`
		);
		return resultFactory.ok(undefined);
	}

	/**
	 * Warden's snapshot of `avd`, built when missing (one writable cold boot, under the AVD's golden lock).
	 * `undefined` = none for now: no SDK root, or the AVD is running so a writable build can't start.
	 * Only `warden golden ensure` (`explicit`: also forgets the AVD's load failures, so gc builds it again)
	 * and `warden gc` call this, never a claim.
	 */
	async ensure(avd: string, opts: { explicit?: boolean } = {}): AsyncResult<EnsuredSnapshot | undefined> {
		const { deps } = this;
		if (opts.explicit) this.pending.resetLoadFailures(avd);
		const current = await this.current(avd);
		if (!current.success || current.data === undefined) return current.success ? resultFactory.ok(undefined) : current;
		const { dir, key, name, present } = current.data;
		const ensured: Result<EnsuredSnapshot | undefined> = present
			? resultFactory.ok({ avd, name, key, built: false })
			: await buildLock.hold(this.lockDeps(), androidSnapshotModel.lockKey(biometricProfiles.split(avd).profile), () =>
					this.ensureLocked(avd, dir, key)
				);
		if (!ensured.success) this.pending.markFailed(avd, deps.now());
		else if (ensured.data !== undefined) this.pending.clear(avd);
		return ensured;
	}

	/** `warden gc`'s step: build the snapshot of the first pending AVD that is idle; at most one build per pass. */
	async buildPending(): AsyncResult<SnapshotPass> {
		const { deps } = this;
		const busy: string[] = [];
		for (const avd of this.pending.pending(deps.now())) {
			const ensured = await this.ensure(avd);
			if (!ensured.success) return resultFactory.ok({ failed: { avd, error: ensured.error }, busy });
			if (ensured.data === undefined) {
				busy.push(avd);
				this.pending.markBusy(avd, deps.now());
			} else if (ensured.data.built) return resultFactory.ok({ built: ensured.data, busy });
		}
		return resultFactory.ok({ busy });
	}

	/**
	 * A claim saw `name` of `avd` fail to load: delete it under the AVD's lock (not waiting for a build that
	 * holds it) and mark the AVD pending, so the next build replaces it. A second failure within
	 * `ANDROID_SNAPSHOT_RETRY_MS` waits out the retry time; after `ANDROID_SNAPSHOT_MAX_LOAD_FAILURES` gc no
	 * longer rebuilds it (`warden golden ensure --platform android` does).
	 */
	async invalidate(avd: string, name: string): AsyncResult<void> {
		const { deps } = this;
		const model = androidSnapshotModel;
		if (!model.isWarden(name)) return resultFactory.err(`${name} is not a warden snapshot`);
		const real = biometricProfiles.split(avd).profile;
		return buildLock.hold({ ...this.lockDeps(), waitMs: 0 }, model.lockKey(real), async () => {
			const deleted = this.deleteSnapshot(real, model.avdDir(deps.env, real), name);
			if (deleted.success) this.noteLoadFailure(avd, name);
			return deleted;
		});
	}

	/** Every warden snapshot of every AVD, `current` = named for the AVD's key today. */
	async list(): AsyncResult<AndroidSnapshotEntry[]> {
		const { deps } = this;
		const model = androidSnapshotModel;
		const avds = await new Adb(deps).listAvds();
		if (!avds.success) return wardenErrors.toText(avds);
		const entries: AndroidSnapshotEntry[] = [];
		for (const avd of avds.data) {
			const dir = model.avdDir(deps.env, avd);
			const names = model.wardenSnapshots(dir);
			if (names.length === 0) continue;
			const current = new Set<string>();
			for (const target of model.targetsOf(avd)) {
				const read = await this.readInputs(target);
				if (read.success && read.data !== undefined) current.add(model.name(model.key(read.data.inputs)));
			}
			for (const name of names)
				entries.push({ avd, name, path: model.snapshotDir(dir, name), current: current.has(name) });
		}
		return resultFactory.ok(entries);
	}

	/** Delete stale warden snapshots (or all with `all`), skipping AVDs that are running. */
	async prune(opts: { all: boolean }): AsyncResult<AndroidSnapshotEntry[]> {
		const listed = await this.list();
		if (!listed.success) return listed;
		const deleted: AndroidSnapshotEntry[] = [];
		for (const avd of new Set(listed.data.map((e) => e.avd))) {
			const targets = listed.data.filter((e) => e.avd === avd && (opts.all || !e.current));
			if (targets.length === 0) continue;
			const pruned = await buildLock.hold(this.lockDeps(), androidSnapshotModel.lockKey(avd), () =>
				this.pruneLocked(avd, targets)
			);
			if (!pruned.success) return pruned;
			deleted.push(...pruned.data);
		}
		return resultFactory.ok(deleted);
	}

	private timing(): AndroidGoldenTiming {
		return { ...DEFAULT_ANDROID_GOLDEN_TIMING, ...this.deps.timing };
	}

	private log(line: string): void {
		this.deps.log?.(`golden: ${line}`);
	}

	private lockDeps() {
		return { ...this.deps, waitMs: this.timing().lockWaitMs, log: (line: string) => this.log(line) };
	}

	private async emulatorVersion(sdk: string): AsyncResult<string> {
		const { deps } = this;
		const model = androidSnapshotModel;
		const props = model.readText(join(sdk, "emulator", "source.properties"));
		const revision = props !== undefined ? model.parseProperties(props).get("Pkg.Revision") : undefined;
		if (revision) return resultFactory.ok(revision);
		const { emulator } = androidToolsLocator.locate(deps.env);
		const result = await deps.exec([emulator, "-version"], { timeoutMs: LIST_AVDS_TIMEOUT_MS });
		const version = result.exitCode === 0 ? model.parseEmulatorVersion(result.stdout) : undefined;
		return version !== undefined
			? resultFactory.ok(version)
			: resultFactory.err(`cannot tell the emulator version (\`${emulator} -version\`)`);
	}

	/** A biometrics target's `config.ini` text: `hw.fingerprint=yes` set, and written back when `write`. */
	private biometricConfig(dir: string, configText: string, write: boolean): Result<string> {
		const model = androidSnapshotModel;
		if (model.parseProperties(configText).get("hw.fingerprint") === "yes") return resultFactory.ok(configText);
		const patched = model.withFingerprintHardware(configText);
		if (!write) return resultFactory.ok(patched);
		const configPath = join(dir, "config.ini");
		try {
			writeFileSync(configPath, patched);
		} catch (error) {
			return resultFactory.err(
				`cannot set hw.fingerprint=yes in ${configPath}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
		this.log(`set hw.fingerprint=yes in ${configPath} (biometrics)`);
		return resultFactory.ok(patched);
	}

	private deleteSnapshot(avd: string, dir: string, name: string): Result<void> {
		const model = androidSnapshotModel;
		try {
			rmSync(model.snapshotDir(dir, name), { recursive: true, force: true });
			this.log(`deleted snapshot ${name} of ${avd}`);
			return resultFactory.ok(undefined);
		} catch (error) {
			return resultFactory.err(
				`cannot delete ${model.snapshotDir(dir, name)}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/** Running emulators of `avd` (by console `avd name`): a writable instance must not start beside them. */
	private async instancesOf(avd: string): AsyncResult<AdbEmulator[]> {
		const { deps } = this;
		const emulators = await new Adb(deps).listEmulators();
		if (!emulators.success) return wardenErrors.toText(emulators);
		const { adb } = androidToolsLocator.locate(deps.env);
		const names = await Promise.all(
			emulators.data.map(async (emu) => {
				const out = await deps.exec([adb, "-s", emu.serial, "emu", "avd", "name"], {
					timeoutMs: EMU_CONSOLE_TIMEOUT_MS,
				});
				return out.exitCode === 0 ? out.stdout.split("\n")[0]?.trim() : undefined;
			})
		);
		return resultFactory.ok(emulators.data.filter((_, i) => names[i] === avd));
	}

	private async emuConsole(serial: string, args: string[], timeoutMs: number): AsyncResult<string> {
		const { deps } = this;
		const { adb } = androidToolsLocator.locate(deps.env);
		const cmd = [adb, "-s", serial, "emu", ...args];
		const out = await deps.exec(cmd, { timeoutMs });
		// the console answers `KO: <reason>` on failure, and adb still exits 0
		if (out.exitCode !== 0 || /^KO\b/m.test(out.stdout)) {
			const detail = (out.stdout || out.stderr).trim().split("\n").slice(-2).join(" | ");
			return resultFactory.err(`\`${cmd.join(" ")}\` failed${detail ? `: ${detail}` : ""}`);
		}
		return resultFactory.ok(out.stdout);
	}

	/** Poll until `pid` is gone, at most `ms`. */
	private async exited(pid: number, ms: number): Promise<boolean> {
		const { deps } = this;
		const deadline = deps.now() + ms;
		while (deps.pidAlive(pid)) {
			if (deps.now() >= deadline) return false;
			await deps.sleep(this.timing().exitPollMs);
		}
		return true;
	}

	private sigkill(pid: number): void {
		try {
			(this.deps.kill ?? ((p, signal) => process.kill(p, signal)))(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}

	/**
	 * `emu kill`, then wait for the process to go: the AVD is free again only once it has. Still there after
	 * the exit timeout → SIGKILL `pid` (a build emulator warden launched itself).
	 */
	private async stopEmulator(serial: string, pid: number): AsyncResult<void> {
		const t = this.timing();
		await this.emuConsole(serial, ["kill"], EMU_CONSOLE_TIMEOUT_MS);
		if (await this.exited(pid, t.exitTimeoutMs)) return resultFactory.ok(undefined);
		this.log(`${serial} (pid ${pid}) still running ${t.exitTimeoutMs / 1000}s after emu kill: SIGKILL`);
		this.sigkill(pid);
		if (await this.exited(pid, t.killGraceMs)) return resultFactory.ok(undefined);
		return resultFactory.err(`${serial} (pid ${pid}) still running after emu kill and SIGKILL`);
	}

	/** The writable cold boot of `avd` that the snapshot is saved from; never touches its `default_boot`. */
	private buildArgv(avd: string, port: number, headless = true): string[] {
		return [
			androidToolsLocator.locate(this.deps.env).emulator,
			"-avd",
			avd,
			"-port",
			String(port),
			"-no-window",
			"-no-boot-anim",
			...(headless ? emulatorArgv.headlessFlags(this.deps.env) : []),
			"-no-snapshot-load",
			"-no-snapshot-save",
		];
	}

	/** Enroll a fingerprint, then park the emulator past the PIN lock screen and awake (the snapshot is RAM + disk). */
	private async prepareBiometrics(serial: string): AsyncResult<unknown> {
		const { deps } = this;
		const { adb } = androidToolsLocator.locate(deps.env);
		this.log(`enrolling a fingerprint on ${serial} (PIN set for the lock screen)`);
		const enrolled = await new FingerprintEnroller({ exec: deps.exec, sleep: deps.sleep, adb }).enroll(serial);
		if (!enrolled.success) return enrolled;
		// the snapshot is RAM + disk: saved past the PIN lock screen and awake, it restores unlocked
		const keyguard = { exec: deps.exec, sleep: deps.sleep, adb, now: deps.now };
		return new AndroidKeyguard(keyguard).ensureUnlocked(serial);
	}

	/** boot → settle → `avd snapshot save` → kill; on any failure the instance is killed and the partial snapshot removed. */
	private async saveFromInstance(
		target: { avd: string; dir: string; name: string },
		serial: string,
		launched: { pid: number; logPath: string },
		biometrics = false
	): AsyncResult<void> {
		const { deps } = this;
		const model = androidSnapshotModel;
		const t = this.timing();
		const booted = await new BootWaiter({ ...deps, pollIntervalMs: 250 }).wait(serial, t.bootTimeoutMs, launched);
		let saved: Result<unknown> = wardenErrors.toText(booted);
		if (booted.success && biometrics) saved = await this.prepareBiometrics(serial);
		if (saved.success && booted.success) {
			await deps.sleep(t.settleMs);
			saved = await this.emuConsole(serial, ["avd", "snapshot", "save", target.name], t.saveTimeoutMs);
		}
		const stopped = await this.stopEmulator(serial, launched.pid);
		if (saved.success && stopped.success && model.complete(target.dir, target.name)) return resultFactory.ok(undefined);
		this.deleteSnapshot(target.avd, target.dir, target.name);
		if (!saved.success) return saved;
		if (!stopped.success) return stopped;
		return resultFactory.err(
			`snapshot ${target.name} of ${target.avd} was not written (${model.snapshotDir(target.dir, target.name)})`
		);
	}

	/** Launch the build instance; an emulator that rejects the headless flags gets one more try without them. */
	private async launchBuild(avd: string, port: number, logPath: string): AsyncResult<{ pid: number }> {
		const { deps } = this;
		const spawn = deps.spawnDetached ?? new DetachedSpawner().spawn;
		const launched = await spawn(this.buildArgv(avd, port), logPath);
		if (launched.success || !emulatorArgv.rejectedOption(launched.error)) return launched;
		this.log(`the emulator rejected ${emulatorArgv.headlessFlags(deps.env).join(" ")} — relaunching without them`);
		return spawn(this.buildArgv(avd, port, false), logPath);
	}

	/** Caller holds the AVD's golden lock and has checked it is not running. */
	private async buildSnapshot(target: string, dir: string, key: string): AsyncResult<void> {
		const { deps } = this;
		const model = androidSnapshotModel;
		const { profile: avd, biometrics } = biometricProfiles.split(target);
		const name = model.name(key);
		const started = deps.now();
		if (deps.prewarmHint) {
			this.log(
				`building quick-boot snapshot for ${avd} (first claim, a cold boot plus ~${Math.round(this.timing().settleMs / 1000)}s); prewarm with: warden golden ensure --platform android --profile ${model.targetProfile(target)}`
			);
		}
		this.log(`building ${name} of ${avd} — one-time cold boot`);
		const running = await new Adb(deps).listEmulators();
		const leased = new ConsolePortLeaser(deps).lease(`golden ${avd}`, running.success ? running.data : []);
		if (!leased.success) return wardenErrors.toText(leased);
		let pid: number | undefined;
		try {
			const serial = `emulator-${leased.data.port}`;
			const logDir = join(storeLocator.wardenHome(deps.env), "logs");
			mkdirSync(logDir, { recursive: true });
			const logPath = join(logDir, `golden-${model.targetProfile(target)}.log`);
			const launched = await this.launchBuild(avd, leased.data.port, logPath);
			if (!launched.success) return launched;
			pid = launched.data.pid;
			// the port lease now lives as long as the build emulator does, so a leftover one keeps its port
			deps.store.setLeasePid(leased.data.lease.id, pid);
			const saved = await this.saveFromInstance({ avd, dir, name }, serial, { pid, logPath }, biometrics);
			if (saved.success) this.log(`${name} of ${avd} ready in ${Math.round((deps.now() - started) / 1000)}s`);
			return saved;
		} catch (error) {
			return resultFactory.err(error);
		} finally {
			// an instance that outlived emu kill and SIGKILL keeps its lease: the next build of the AVD reaps it
			if (pid === undefined || !deps.pidAlive(pid)) deps.store.deleteLeases([leased.data.lease.id]);
		}
	}

	/** `pid`'s command line names `-avd <avd>` and `-port <port>`: it is that build emulator, not a reused pid. */
	private async isBuildEmulator(pid: number, avd: string, port: number): Promise<boolean> {
		const out = await this.deps.exec(["ps", "-o", "command=", "-p", String(pid)], {
			timeoutMs: EMU_CONSOLE_TIMEOUT_MS,
		});
		if (out.exitCode !== 0) return false;
		const argv = out.stdout.trim().split(/\s+/);
		const flag = (name: string, value: string) => argv.some((arg, i) => arg === name && argv[i + 1] === value);
		return flag("-avd", avd) && flag("-port", String(port));
	}

	/**
	 * Build emulators an earlier warden left running (it died, or could not stop one): any golden-port lease
	 * of `avd` seen while holding the AVD's lock is one, since its builder no longer holds the lock. Only a
	 * lease whose pid is alive and is that emulator (its command line names the AVD and the port) is acted
	 * on: its instance is stopped (`emu kill`, then SIGKILL of the pid) and the lease dropped, or, when adb
	 * does not name the instance (wedged, booting, offline), the lease is kept and the AVD counts as busy.
	 * A dead, missing or reused pid only drops the lease: whatever runs on that port now is not warden's.
	 */
	private async reapLeftoverBuilds(
		avd: string,
		instances: AdbEmulator[]
	): AsyncResult<{ stopped: Set<string>; held: string[] }> {
		const { deps } = this;
		const stopped = new Set<string>();
		const held: string[] = [];
		const leftovers = deps.store
			.listLeases()
			.filter((l) => l.resource.kind === "port" && l.label === `${GOLDEN_PORT_LABEL}${avd}`);
		for (const lease of leftovers) {
			if (lease.resource.kind !== "port") continue;
			const serial = `emulator-${lease.resource.port}`;
			const pid = lease.pid;
			const ours =
				pid !== undefined && deps.pidAlive(pid) && (await this.isBuildEmulator(pid, avd, lease.resource.port));
			if (ours && !instances.some((e) => e.serial === serial)) {
				held.push(serial);
				continue;
			}
			if (ours) {
				this.log(`stopping the leftover build emulator ${serial} of ${avd}`);
				const done = await this.stopEmulator(serial, pid);
				if (!done.success) return done;
				stopped.add(serial);
			}
			deps.store.deleteLeases([lease.id]);
		}
		return resultFactory.ok({ stopped, held });
	}

	/** Snapshot names the AVD's other target (plain ↔ biometrics) is current at: a build of one never deletes them. */
	private async siblingNames(target: string): Promise<Set<string>> {
		const model = androidSnapshotModel;
		const { profile: avd, biometrics } = biometricProfiles.split(target);
		const other = biometrics ? avd : biometricProfiles.profile(avd, true);
		const read = await this.readInputs(other);
		return new Set(read.success && read.data !== undefined ? [model.name(model.key(read.data.inputs))] : []);
	}

	private async ensureLocked(target: string, dir: string, key: string): AsyncResult<EnsuredSnapshot | undefined> {
		const model = androidSnapshotModel;
		const { profile: avd } = biometricProfiles.split(target);
		const name = model.name(key);
		if (model.complete(dir, name)) return resultFactory.ok({ avd: target, name, key, built: false });
		const instances = await this.instancesOf(avd);
		if (!instances.success) return instances;
		const reaped = await this.reapLeftoverBuilds(avd, instances.data);
		if (!reaped.success) return reaped;
		// conservative: any instance of the AVD, warden's own read-only ones included, keeps the writable build off
		const busy = [
			...instances.data.filter((e) => !reaped.data.stopped.has(e.serial)).map((e) => e.serial),
			...reaped.data.held,
		];
		if (busy.length > 0) {
			this.log(`${avd} is running (${busy.join(", ")}): no snapshot built now`);
			return resultFactory.ok(undefined);
		}
		const keep = await this.siblingNames(target);
		for (const stale of model.wardenSnapshots(dir).filter((s) => s !== name && !keep.has(s))) {
			const deleted = this.deleteSnapshot(avd, dir, stale);
			if (!deleted.success) return deleted;
		}
		const built = await this.buildSnapshot(target, dir, key);
		return built.success ? resultFactory.ok({ avd: target, name, key, built: true }) : built;
	}

	/** Record the load failure of a deleted snapshot and say what gc will do about it. */
	private noteLoadFailure(avd: string, name: string): void {
		const { loadFailures, deferred } = this.pending.recordLoadFailure(avd, this.deps.now());
		const ensure = `warden golden ensure --platform android --profile ${androidSnapshotModel.targetProfile(avd)}`;
		if (loadFailures >= ANDROID_SNAPSHOT_MAX_LOAD_FAILURES) {
			this.log(`${name} of ${avd} failed to load ${loadFailures} times: gc no longer rebuilds it (${ensure} does)`);
		} else if (deferred) {
			this.log(
				`${name} of ${avd} does not load on this host (failed again): next rebuild in ${ANDROID_SNAPSHOT_RETRY_MS / 3_600_000}h`
			);
		}
	}

	/** Caller holds the AVD's lock: delete `targets` unless an instance of the AVD runs. */
	private async pruneLocked(avd: string, targets: AndroidSnapshotEntry[]): AsyncResult<AndroidSnapshotEntry[]> {
		const busy = await this.instancesOf(avd);
		if (!busy.success) return busy;
		if (busy.data.length > 0) {
			this.log(`${avd} is running: its snapshots are kept`);
			return resultFactory.ok([]);
		}
		const dir = androidSnapshotModel.avdDir(this.deps.env, avd);
		for (const target of targets) {
			const removed = this.deleteSnapshot(avd, dir, target.name);
			if (!removed.success) return removed;
		}
		return resultFactory.ok(targets);
	}
}
