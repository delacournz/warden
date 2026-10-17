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
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { profileSlug } from "../allocate";
import { withBuildLock } from "../builds/lock";
import type { Exec } from "../exec";
import type { PidAlive } from "../liveness";
import {
	type AdbEmulator,
	androidTools,
	createSpawnDetached,
	EMU_CONSOLE_TIMEOUT_MS,
	GOLDEN_PORT_LABEL,
	headlessEmulatorFlags,
	LIST_AVDS_TIMEOUT_MS,
	leaseConsolePort,
	listAvds,
	listEmulators,
	rejectedOption,
	type SpawnDetached,
	waitBootCompleted,
} from "../providers/android";
import { type Store, wardenHome } from "../store";
import type { Owner } from "../types";
import {
	clearAndroidSnapshotPending,
	markAndroidSnapshotFailed,
	markAndroidSnapshotPending,
	pendingAndroidSnapshots,
} from "./android-snapshot-pending";

/** Bump when what building a snapshot does to the device changes, so existing snapshots go stale. */
export const ANDROID_SNAPSHOT_RECIPE = 1;
export const ANDROID_SNAPSHOT_PREFIX = "warden-";
const SNAPSHOT_PATTERN = /^warden-[0-9a-f]{10}$/;

export const androidGoldenLockKey = (avd: string) => `golden:android:${avd}`;
export const snapshotName = (key: string) => `${ANDROID_SNAPSHOT_PREFIX}${key}`;
export const isWardenSnapshot = (name: string) => SNAPSHOT_PATTERN.test(name);

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
};

/** Non-`hw.*` `config.ini` keys that change the guest a snapshot captures (`fastboot.*`, display names do not). */
const KEYED_CONFIG =
	/^(hw\.|image\.sysdir\.|abi\.type$|tag\.ids?$|PlayStore\.enabled$|disk\.dataPartition\.size$|sdcard\.(size|path)$|vm\.heapSize$|target$)/;

/** 10 hex chars of sha256 over everything that makes one snapshot unusable for another. */
export function androidSnapshotKey(inputs: AndroidSnapshotInputs, recipe: number = ANDROID_SNAPSHOT_RECIPE): string {
	const material = [
		inputs.imageRevision,
		inputs.fingerprint,
		inputs.emulatorVersion,
		...[...inputs.hardware].sort(),
		...(inputs.flags !== undefined ? [`flags:${inputs.flags.join(" ")}`] : []),
		`r${recipe}`,
	].join("|");
	return new Bun.CryptoHasher("sha256").update(material).digest("hex").slice(0, 10);
}

/** `key=value` lines (`source.properties`, `config.ini`, `build.prop`, `<avd>.ini`). */
export function parseProperties(text: string): Map<string, string> {
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
export function parseEmulatorVersion(stdout: string): string | undefined {
	return /emulator version (\S+)/i.exec(stdout)?.[1];
}

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

/**
 * `WARDEN_ANDROID_SNAPSHOT` when it says on or off (0/1/true/false/on/off/yes/no, any case); unset or
 * empty → `undefined`, anything else → `warn(value)` and `undefined`, so the config decides.
 */
export function explicitAndroidSnapshot(
	env: Record<string, string | undefined>,
	warn?: (value: string) => void
): boolean | undefined {
	const value = env.WARDEN_ANDROID_SNAPSHOT?.trim();
	if (value === undefined || value === "") return undefined;
	const parsed = SNAPSHOT_ENV_VALUES[value.toLowerCase()];
	if (parsed === undefined) warn?.(value);
	return parsed;
}

/** On unless `WARDEN_ANDROID_SNAPSHOT` is off; an explicit on wins over a config `android.snapshot: false`. */
export function androidSnapshotEnabled(env: Record<string, string | undefined>, configured?: boolean): boolean {
	return explicitAndroidSnapshot(env) ?? configured !== false;
}

/**
 * Where AVDs live, in the emulator's order: `$ANDROID_AVD_HOME`, `$ANDROID_EMULATOR_HOME/avd`,
 * `$ANDROID_USER_HOME/avd`, `$ANDROID_SDK_HOME/.android/avd`, else `~/.android/avd`.
 */
export function avdHome(env: Record<string, string | undefined>): string {
	if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
	if (env.ANDROID_EMULATOR_HOME) return join(env.ANDROID_EMULATOR_HOME, "avd");
	if (env.ANDROID_USER_HOME) return join(env.ANDROID_USER_HOME, "avd");
	if (env.ANDROID_SDK_HOME) return join(env.ANDROID_SDK_HOME, ".android", "avd");
	return join(env.HOME || homedir(), ".android", "avd");
}

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** The AVD's content dir: `path=` of `<home>/<avd>.ini`, else `<home>/<avd>.avd`. */
export function avdDir(env: Record<string, string | undefined>, avd: string): string {
	const home = avdHome(env);
	const ini = readText(join(home, `${avd}.ini`));
	const path = ini !== undefined ? parseProperties(ini).get("path") : undefined;
	return path !== undefined && path !== "" ? path : join(home, `${avd}.avd`);
}

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

const timing = (deps: AndroidGoldenDeps): AndroidGoldenTiming => ({ ...DEFAULT_ANDROID_GOLDEN_TIMING, ...deps.timing });
const log = (deps: AndroidGoldenDeps, line: string) => deps.log?.(`golden: ${line}`);
const snapshotDir = (dir: string, name: string) => join(dir, "snapshots", name);
/** `snapshot.pb` is the snapshot's metadata, written once a save completes. */
const snapshotComplete = (dir: string, name: string) => existsSync(join(snapshotDir(dir, name), "snapshot.pb"));

async function emulatorVersion(deps: AndroidGoldenDeps, sdk: string): AsyncResult<string> {
	const props = readText(join(sdk, "emulator", "source.properties"));
	const revision = props !== undefined ? parseProperties(props).get("Pkg.Revision") : undefined;
	if (revision) return ok(revision);
	const { emulator } = androidTools(deps.env);
	const result = await deps.exec([emulator, "-version"], { timeoutMs: LIST_AVDS_TIMEOUT_MS });
	const version = result.exitCode === 0 ? parseEmulatorVersion(result.stdout) : undefined;
	return version !== undefined ? ok(version) : err(`cannot tell the emulator version (\`${emulator} -version\`)`);
}

/** Processes (per `exec`, so once per CLI process) already told there is no SDK root. */
const toldNoSdk = new WeakSet<Exec>();

/**
 * The key inputs of `avd`, from files only in the common case (no spawn). `undefined` = no SDK root
 * (`ANDROID_HOME` / `ANDROID_SDK_ROOT` unset): warden cannot find the system image, so no snapshot
 * (said once per process).
 */
export async function readSnapshotInputs(
	deps: AndroidGoldenDeps,
	avd: string
): AsyncResult<{ inputs: AndroidSnapshotInputs; dir: string } | undefined> {
	const sdk = deps.env.ANDROID_HOME || deps.env.ANDROID_SDK_ROOT;
	if (!sdk) {
		if (!toldNoSdk.has(deps.exec)) {
			toldNoSdk.add(deps.exec);
			log(deps, "ANDROID_HOME / ANDROID_SDK_ROOT unset: no quick-boot snapshots, emulators cold-boot");
		}
		return ok(undefined);
	}
	const dir = avdDir(deps.env, avd);
	const configText = readText(join(dir, "config.ini"));
	if (configText === undefined) return err(`no config.ini in ${dir}`);
	const config = parseProperties(configText);
	const sysdir = config.get("image.sysdir.1");
	if (!sysdir) return err(`${join(dir, "config.ini")} names no image.sysdir.1`);
	const imageDir = isAbsolute(sysdir) ? sysdir : join(sdk, sysdir);
	const source = readText(join(imageDir, "source.properties"));
	const imageRevision = source !== undefined ? parseProperties(source).get("Pkg.Revision") : undefined;
	if (!imageRevision) return err(`no Pkg.Revision in ${join(imageDir, "source.properties")}`);
	const buildProp = parseProperties(readText(join(imageDir, "build.prop")) ?? "");
	const fingerprint = buildProp.get("ro.build.fingerprint") ?? buildProp.get("ro.system.build.fingerprint") ?? "";
	const version = await emulatorVersion(deps, sdk);
	if (!version.success) return version;
	const hardware = [...config].filter(([k]) => KEYED_CONFIG.test(k)).map(([k, v]) => `${k}=${v}`);
	const flags = headlessEmulatorFlags(deps.env);
	return ok({ inputs: { imageRevision, fingerprint, emulatorVersion: version.data, hardware, flags }, dir });
}

/** Warden snapshots in an AVD dir (`snapshots/warden-<10 hex>`). */
function wardenSnapshots(dir: string): string[] {
	try {
		return readdirSync(join(dir, "snapshots")).filter(isWardenSnapshot).sort();
	} catch {
		return [];
	}
}

function deleteSnapshot(deps: AndroidGoldenDeps, avd: string, dir: string, name: string): Result<void> {
	try {
		rmSync(snapshotDir(dir, name), { recursive: true, force: true });
		log(deps, `deleted snapshot ${name} of ${avd}`);
		return ok(undefined);
	} catch (error) {
		return err(`cannot delete ${snapshotDir(dir, name)}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Running emulators of `avd` (by console `avd name`): a writable instance must not start beside them. */
async function instancesOf(deps: AndroidGoldenDeps, avd: string): AsyncResult<AdbEmulator[]> {
	const emulators = await listEmulators(deps);
	if (!emulators.success) return emulators;
	const { adb } = androidTools(deps.env);
	const names = await Promise.all(
		emulators.data.map(async (emu) => {
			const out = await deps.exec([adb, "-s", emu.serial, "emu", "avd", "name"], {
				timeoutMs: EMU_CONSOLE_TIMEOUT_MS,
			});
			return out.exitCode === 0 ? out.stdout.split("\n")[0]?.trim() : undefined;
		})
	);
	return ok(emulators.data.filter((_, i) => names[i] === avd));
}

async function emuConsole(
	deps: AndroidGoldenDeps,
	serial: string,
	args: string[],
	timeoutMs: number
): AsyncResult<string> {
	const { adb } = androidTools(deps.env);
	const cmd = [adb, "-s", serial, "emu", ...args];
	const out = await deps.exec(cmd, { timeoutMs });
	// the console answers `KO: <reason>` on failure, and adb still exits 0
	if (out.exitCode !== 0 || /^KO\b/m.test(out.stdout)) {
		const detail = (out.stdout || out.stderr).trim().split("\n").slice(-2).join(" | ");
		return err(`\`${cmd.join(" ")}\` failed${detail ? `: ${detail}` : ""}`);
	}
	return ok(out.stdout);
}

/** Poll until `pid` is gone, at most `ms`. */
async function exited(deps: AndroidGoldenDeps, pid: number, ms: number): Promise<boolean> {
	const deadline = deps.now() + ms;
	while (deps.pidAlive(pid)) {
		if (deps.now() >= deadline) return false;
		await deps.sleep(timing(deps).exitPollMs);
	}
	return true;
}

function sigkill(deps: AndroidGoldenDeps, pid: number): void {
	try {
		(deps.kill ?? ((p, signal) => process.kill(p, signal)))(pid, "SIGKILL");
	} catch {
		// already gone
	}
}

/**
 * `emu kill`, then wait for the process to go: the AVD is free again only once it has. Still there after
 * the exit timeout → SIGKILL `pid` (a build emulator warden launched itself).
 */
async function stopEmulator(deps: AndroidGoldenDeps, serial: string, pid: number): AsyncResult<void> {
	const t = timing(deps);
	await emuConsole(deps, serial, ["kill"], EMU_CONSOLE_TIMEOUT_MS);
	if (await exited(deps, pid, t.exitTimeoutMs)) return ok(undefined);
	log(deps, `${serial} (pid ${pid}) still running ${t.exitTimeoutMs / 1000}s after emu kill: SIGKILL`);
	sigkill(deps, pid);
	if (await exited(deps, pid, t.killGraceMs)) return ok(undefined);
	return err(`${serial} (pid ${pid}) still running after emu kill and SIGKILL`);
}

/** The writable cold boot of `avd` that the snapshot is saved from; never touches its `default_boot`. */
function buildArgv(deps: AndroidGoldenDeps, avd: string, port: number, headless = true): string[] {
	return [
		androidTools(deps.env).emulator,
		"-avd",
		avd,
		"-port",
		String(port),
		"-no-window",
		"-no-boot-anim",
		...(headless ? headlessEmulatorFlags(deps.env) : []),
		"-no-snapshot-load",
		"-no-snapshot-save",
	];
}

/** boot → settle → `avd snapshot save` → kill; on any failure the instance is killed and the partial snapshot removed. */
async function saveFromInstance(
	deps: AndroidGoldenDeps,
	target: { avd: string; dir: string; name: string },
	serial: string,
	launched: { pid: number; logPath: string }
): AsyncResult<void> {
	const t = timing(deps);
	const booted = await waitBootCompleted({ ...deps, pollIntervalMs: 250 }, serial, t.bootTimeoutMs, launched);
	let saved: Result<unknown> = booted;
	if (booted.success) {
		await deps.sleep(t.settleMs);
		saved = await emuConsole(deps, serial, ["avd", "snapshot", "save", target.name], t.saveTimeoutMs);
	}
	const stopped = await stopEmulator(deps, serial, launched.pid);
	if (saved.success && stopped.success && snapshotComplete(target.dir, target.name)) return ok(undefined);
	deleteSnapshot(deps, target.avd, target.dir, target.name);
	if (!saved.success) return saved;
	if (!stopped.success) return stopped;
	return err(`snapshot ${target.name} of ${target.avd} was not written (${snapshotDir(target.dir, target.name)})`);
}

/** Caller holds the AVD's golden lock and has checked it is not running. */
/** Launch the build instance; an emulator that rejects the headless flags gets one more try without them. */
async function launchBuild(
	deps: AndroidGoldenDeps,
	avd: string,
	port: number,
	logPath: string
): AsyncResult<{ pid: number }> {
	const spawn = deps.spawnDetached ?? createSpawnDetached();
	const launched = await spawn(buildArgv(deps, avd, port), logPath);
	if (launched.success || !rejectedOption(launched.error)) return launched;
	log(deps, `the emulator rejected ${headlessEmulatorFlags(deps.env).join(" ")} — relaunching without them`);
	return spawn(buildArgv(deps, avd, port, false), logPath);
}

async function buildSnapshot(deps: AndroidGoldenDeps, avd: string, dir: string, key: string): AsyncResult<void> {
	const name = snapshotName(key);
	const started = deps.now();
	if (deps.prewarmHint) {
		log(
			deps,
			`building quick-boot snapshot for ${avd} (first claim, a cold boot plus ~${Math.round(timing(deps).settleMs / 1000)}s); prewarm with: warden golden ensure --platform android --profile ${profileSlug(avd)}`
		);
	}
	log(deps, `building ${name} of ${avd} — one-time cold boot`);
	const running = await listEmulators(deps);
	const leased = leaseConsolePort(deps, `golden ${avd}`, running.success ? running.data : []);
	if (!leased.success) return leased;
	let pid: number | undefined;
	try {
		const serial = `emulator-${leased.data.port}`;
		const logDir = join(wardenHome(deps.env), "logs");
		mkdirSync(logDir, { recursive: true });
		const logPath = join(logDir, `golden-${profileSlug(avd)}.log`);
		const launched = await launchBuild(deps, avd, leased.data.port, logPath);
		if (!launched.success) return launched;
		pid = launched.data.pid;
		// the port lease now lives as long as the build emulator does, so a leftover one keeps its port
		deps.store.setLeasePid(leased.data.lease.id, pid);
		const saved = await saveFromInstance(deps, { avd, dir, name }, serial, { pid, logPath });
		if (saved.success) log(deps, `${name} of ${avd} ready in ${Math.round((deps.now() - started) / 1000)}s`);
		return saved;
	} catch (error) {
		return err(error);
	} finally {
		// an instance that outlived emu kill and SIGKILL keeps its lease: the next build of the AVD reaps it
		if (pid === undefined || !deps.pidAlive(pid)) deps.store.deleteLeases([leased.data.lease.id]);
	}
}

/**
 * Build emulators an earlier warden left running (it died, or could not stop one): any golden-port lease
 * of `avd` seen while holding the AVD's lock is one, since its builder no longer holds the lock. Its
 * instance is stopped (`emu kill`, then SIGKILL of the recorded pid) and its lease dropped; returns the
 * serials stopped.
 */
async function reapLeftoverBuilds(
	deps: AndroidGoldenDeps,
	avd: string,
	instances: AdbEmulator[]
): AsyncResult<Set<string>> {
	const stopped = new Set<string>();
	const leftovers = deps.store
		.listLeases()
		.filter((l) => l.resource.kind === "port" && l.label === `${GOLDEN_PORT_LABEL}${avd}`);
	for (const lease of leftovers) {
		if (lease.resource.kind !== "port") continue;
		const serial = `emulator-${lease.resource.port}`;
		if (instances.some((e) => e.serial === serial)) {
			log(deps, `stopping the leftover build emulator ${serial} of ${avd}`);
			const done =
				lease.pid !== undefined
					? await stopEmulator(deps, serial, lease.pid)
					: await emuConsole(deps, serial, ["kill"], EMU_CONSOLE_TIMEOUT_MS);
			if (!done.success) return done;
			stopped.add(serial);
		}
		deps.store.deleteLeases([lease.id]);
	}
	return ok(stopped);
}

async function ensureLocked(
	deps: AndroidGoldenDeps,
	avd: string,
	dir: string,
	key: string
): AsyncResult<EnsuredSnapshot | undefined> {
	const name = snapshotName(key);
	if (snapshotComplete(dir, name)) return ok({ avd, name, key, built: false });
	const instances = await instancesOf(deps, avd);
	if (!instances.success) return instances;
	const reaped = await reapLeftoverBuilds(deps, avd, instances.data);
	if (!reaped.success) return reaped;
	// conservative: any instance of the AVD, warden's own read-only ones included, keeps the writable build off
	const busy = instances.data.filter((e) => !reaped.data.has(e.serial));
	if (busy.length > 0) {
		log(deps, `${avd} is running (${busy.map((e) => e.serial).join(", ")}): no snapshot built now`);
		return ok(undefined);
	}
	for (const stale of wardenSnapshots(dir).filter((s) => s !== name)) {
		const deleted = deleteSnapshot(deps, avd, dir, stale);
		if (!deleted.success) return deleted;
	}
	const built = await buildSnapshot(deps, avd, dir, key);
	return built.success ? ok({ avd, name, key, built: true }) : built;
}

function lockDeps(deps: AndroidGoldenDeps) {
	return { ...deps, waitMs: timing(deps).lockWaitMs, log: (line: string) => log(deps, line) };
}

/** Warden's current snapshot of `avd` and whether it exists; files only, no lock. `undefined` = no SDK root. */
export async function currentAndroidSnapshot(
	deps: AndroidGoldenDeps,
	avd: string
): AsyncResult<{ avd: string; name: string; key: string; dir: string; present: boolean } | undefined> {
	const read = await readSnapshotInputs(deps, avd);
	if (!read.success || read.data === undefined) return read.success ? ok(undefined) : read;
	const { dir, inputs } = read.data;
	const key = androidSnapshotKey(inputs);
	const name = snapshotName(key);
	return ok({ avd, name, key, dir, present: snapshotComplete(dir, name) });
}

/**
 * What a claim launches `avd` from: warden's current snapshot when it exists. Missing → `undefined`
 * (the claim cold-boots read-only as before), one log line, and the AVD is marked for `warden gc` to build.
 */
export async function snapshotForClaim(deps: AndroidGoldenDeps, avd: string): AsyncResult<string | undefined> {
	const current = await currentAndroidSnapshot(deps, avd);
	if (!current.success || current.data === undefined) return current.success ? ok(undefined) : current;
	if (current.data.present) return ok(current.data.name);
	markAndroidSnapshotPending(deps.store, avd);
	log(
		deps,
		`no quick-boot snapshot of ${avd} yet: cold boot (warden gc builds it while ${avd} is idle; now: warden golden ensure --platform android --profile ${profileSlug(avd)})`
	);
	return ok(undefined);
}

/**
 * Warden's snapshot of `avd`, built when missing (one writable cold boot, under the AVD's golden lock).
 * `undefined` = none for now: no SDK root, or the AVD is running so a writable build can't start.
 * Only `warden golden ensure` and `warden gc` call this, never a claim.
 */
export async function ensureAndroidSnapshot(
	deps: AndroidGoldenDeps,
	avd: string
): AsyncResult<EnsuredSnapshot | undefined> {
	const current = await currentAndroidSnapshot(deps, avd);
	if (!current.success || current.data === undefined) return current.success ? ok(undefined) : current;
	const { dir, key, name, present } = current.data;
	const ensured: Result<EnsuredSnapshot | undefined> = present
		? ok({ avd, name, key, built: false })
		: await withBuildLock(lockDeps(deps), androidGoldenLockKey(avd), () => ensureLocked(deps, avd, dir, key));
	if (!ensured.success) markAndroidSnapshotFailed(deps.store, avd, deps.now());
	else if (ensured.data !== undefined) clearAndroidSnapshotPending(deps.store, avd);
	return ensured;
}

export type SnapshotPass = {
	built?: EnsuredSnapshot;
	failed?: { avd: string; error: string };
	/** pending AVDs left for a later pass because an instance of them runs */
	busy: string[];
};

/** `warden gc`'s step: build the snapshot of the first pending AVD that is idle; at most one build per pass. */
export async function buildPendingAndroidSnapshot(deps: AndroidGoldenDeps): AsyncResult<SnapshotPass> {
	const busy: string[] = [];
	for (const avd of pendingAndroidSnapshots(deps.store, deps.now())) {
		const ensured = await ensureAndroidSnapshot(deps, avd);
		if (!ensured.success) return ok({ failed: { avd, error: ensured.error }, busy });
		if (ensured.data === undefined) busy.push(avd);
		else if (ensured.data.built) return ok({ built: ensured.data, busy });
	}
	return ok({ busy });
}

/**
 * A claim saw `name` of `avd` fail to load: delete it under the AVD's lock (not waiting for a build that
 * holds it) and mark the AVD pending, so the next build replaces it.
 */
export async function invalidateAndroidSnapshot(deps: AndroidGoldenDeps, avd: string, name: string): AsyncResult<void> {
	if (!isWardenSnapshot(name)) return err(`${name} is not a warden snapshot`);
	return withBuildLock({ ...lockDeps(deps), waitMs: 0 }, androidGoldenLockKey(avd), async () => {
		const deleted = deleteSnapshot(deps, avd, avdDir(deps.env, avd), name);
		if (deleted.success) {
			// a fresh entry: due at the next gc pass, whatever an earlier build's failure said
			clearAndroidSnapshotPending(deps.store, avd);
			markAndroidSnapshotPending(deps.store, avd);
		}
		return deleted;
	});
}

/** Every warden snapshot of every AVD, `current` = named for the AVD's key today. */
export async function listAndroidSnapshots(deps: AndroidGoldenDeps): AsyncResult<AndroidSnapshotEntry[]> {
	const avds = await listAvds(deps);
	if (!avds.success) return avds;
	const entries: AndroidSnapshotEntry[] = [];
	for (const avd of avds.data) {
		const dir = avdDir(deps.env, avd);
		const names = wardenSnapshots(dir);
		if (names.length === 0) continue;
		const read = await readSnapshotInputs(deps, avd);
		const current = read.success && read.data !== undefined ? snapshotName(androidSnapshotKey(read.data.inputs)) : "";
		for (const name of names) entries.push({ avd, name, path: snapshotDir(dir, name), current: name === current });
	}
	return ok(entries);
}

/** Delete stale warden snapshots (or all with `all`), skipping AVDs that are running. */
export async function pruneAndroidSnapshots(
	deps: AndroidGoldenDeps,
	opts: { all: boolean }
): AsyncResult<AndroidSnapshotEntry[]> {
	const listed = await listAndroidSnapshots(deps);
	if (!listed.success) return listed;
	const deleted: AndroidSnapshotEntry[] = [];
	for (const avd of new Set(listed.data.map((e) => e.avd))) {
		const targets = listed.data.filter((e) => e.avd === avd && (opts.all || !e.current));
		if (targets.length === 0) continue;
		const pruned = await withBuildLock(lockDeps(deps), androidGoldenLockKey(avd), async () => {
			const busy = await instancesOf(deps, avd);
			if (!busy.success) return busy;
			if (busy.data.length > 0) {
				log(deps, `${avd} is running: its snapshots are kept`);
				return ok([]);
			}
			const dir = avdDir(deps.env, avd);
			for (const target of targets) {
				const removed = deleteSnapshot(deps, avd, dir, target.name);
				if (!removed.success) return removed;
			}
			return ok(targets);
		});
		if (!pruned.success) return pruned;
		deleted.push(...pruned.data);
	}
	return ok(deleted);
}
