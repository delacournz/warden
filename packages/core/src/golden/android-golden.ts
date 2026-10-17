/**
 * Android golden: one warden-owned quick-boot snapshot (`warden-<key>`) per AVD, saved from a writable,
 * cold-booted, settled run of that AVD. Claims launch `-read-only -snapshot warden-<key>` instead of
 * whatever `default_boot` the user's last writable run (Android Studio) left behind, so boot time and
 * start state no longer depend on it. Mirrors `ios-golden.ts`: all work on one AVD's snapshots runs
 * under the machine-wide `golden:android:<avd>` build lease.
 *
 * The key covers what makes a snapshot unloadable or different: the system image revision and build
 * fingerprint, the emulator version, the AVD's `hw.*` config and the recipe. A key change leaves the old
 * snapshot stale; the next build of that AVD (or `warden golden prune --platform android`) deletes it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
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
	headlessEmulatorFlags,
	LIST_AVDS_TIMEOUT_MS,
	leaseConsolePort,
	listAvds,
	listEmulators,
	type SpawnDetached,
	waitBootCompleted,
} from "../providers/android";
import { type Store, wardenHome } from "../store";
import type { Owner } from "../types";

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
	/** the AVD `config.ini` `hw.*` lines plus its `image.sysdir.1` */
	hardware: string[];
};

/** 10 hex chars of sha256 over everything that makes one snapshot unusable for another. */
export function androidSnapshotKey(inputs: AndroidSnapshotInputs, recipe: number = ANDROID_SNAPSHOT_RECIPE): string {
	const material = [
		inputs.imageRevision,
		inputs.fingerprint,
		inputs.emulatorVersion,
		...[...inputs.hardware].sort(),
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

/** On unless `WARDEN_ANDROID_SNAPSHOT=0`; `=1` wins over a config `android.snapshot: false`. */
export function androidSnapshotEnabled(env: Record<string, string | undefined>, configured?: boolean): boolean {
	const value = env.WARDEN_ANDROID_SNAPSHOT?.trim();
	if (value === "0" || value === "false") return false;
	if (value === "1" || value === "true") return true;
	return configured !== false;
}

/** Where AVDs live: `$ANDROID_AVD_HOME`, else `$ANDROID_USER_HOME/avd`, else `~/.android/avd`. */
export function avdHome(env: Record<string, string | undefined>): string {
	if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
	if (env.ANDROID_USER_HOME) return join(env.ANDROID_USER_HOME, "avd");
	return join(env.HOME ?? "~", ".android", "avd");
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
	/** after `emu kill`: how long to wait for the process to exit */
	exitTimeoutMs: number;
	exitPollMs: number;
	lockWaitMs: number;
};

export const DEFAULT_ANDROID_GOLDEN_TIMING: AndroidGoldenTiming = {
	bootTimeoutMs: 10 * 60_000,
	settleMs: 20_000,
	saveTimeoutMs: 3 * 60_000,
	exitTimeoutMs: 60_000,
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

/**
 * The key inputs of `avd`, from files only in the common case (no spawn). `undefined` = no SDK root
 * (`ANDROID_HOME` / `ANDROID_SDK_ROOT` unset): warden cannot find the system image, so no snapshot.
 */
export async function readSnapshotInputs(
	deps: AndroidGoldenDeps,
	avd: string
): AsyncResult<{ inputs: AndroidSnapshotInputs; dir: string } | undefined> {
	const sdk = deps.env.ANDROID_HOME || deps.env.ANDROID_SDK_ROOT;
	if (!sdk) return ok(undefined);
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
	const hardware = [
		...[...config].filter(([k]) => k.startsWith("hw.")).map(([k, v]) => `${k}=${v}`),
		`image.sysdir.1=${sysdir}`,
	];
	return ok({ inputs: { imageRevision, fingerprint, emulatorVersion: version.data, hardware }, dir });
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

/** `emu kill`, then wait for the process to go: the AVD is free again only once it has. */
async function stopEmulator(deps: AndroidGoldenDeps, serial: string, pid: number): AsyncResult<void> {
	const t = timing(deps);
	await emuConsole(deps, serial, ["kill"], EMU_CONSOLE_TIMEOUT_MS);
	const deadline = deps.now() + t.exitTimeoutMs;
	while (deps.pidAlive(pid)) {
		if (deps.now() >= deadline)
			return err(`${serial} (pid ${pid}) still running ${t.exitTimeoutMs / 1000}s after emu kill`);
		await deps.sleep(t.exitPollMs);
	}
	return ok(undefined);
}

/** The writable cold boot of `avd` that the snapshot is saved from; never touches its `default_boot`. */
function buildArgv(deps: AndroidGoldenDeps, avd: string, port: number): string[] {
	return [
		androidTools(deps.env).emulator,
		"-avd",
		avd,
		"-port",
		String(port),
		"-no-window",
		"-no-boot-anim",
		...headlessEmulatorFlags(deps.env),
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
	try {
		const serial = `emulator-${leased.data.port}`;
		const logDir = join(wardenHome(deps.env), "logs");
		mkdirSync(logDir, { recursive: true });
		const logPath = join(logDir, `golden-${profileSlug(avd)}.log`);
		const spawn = deps.spawnDetached ?? createSpawnDetached();
		const launched = await spawn(buildArgv(deps, avd, leased.data.port), logPath);
		if (!launched.success) return launched;
		const saved = await saveFromInstance(deps, { avd, dir, name }, serial, { pid: launched.data.pid, logPath });
		if (saved.success) log(deps, `${name} of ${avd} ready in ${Math.round((deps.now() - started) / 1000)}s`);
		return saved;
	} catch (error) {
		return err(error);
	} finally {
		deps.store.deleteLeases([leased.data.lease.id]);
	}
}

async function ensureLocked(
	deps: AndroidGoldenDeps,
	avd: string,
	dir: string,
	key: string
): AsyncResult<EnsuredSnapshot | undefined> {
	const name = snapshotName(key);
	if (snapshotComplete(dir, name)) return ok({ avd, name, key, built: false });
	const busy = await instancesOf(deps, avd);
	if (!busy.success) return busy;
	if (busy.data.length > 0) {
		log(
			deps,
			`${avd} is running (${busy.data.map((e) => e.serial).join(", ")}): no snapshot built now, this emulator cold-boots`
		);
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

/**
 * Warden's snapshot of `avd`, built on first use (one cold boot, under the AVD's golden lock).
 * `undefined` = none for now: no SDK root, or the AVD is running so a writable build can't start.
 */
export async function ensureAndroidSnapshot(
	deps: AndroidGoldenDeps,
	avd: string
): AsyncResult<EnsuredSnapshot | undefined> {
	const read = await readSnapshotInputs(deps, avd);
	if (!read.success || read.data === undefined) return read.success ? ok(undefined) : read;
	const { dir, inputs } = read.data;
	const key = androidSnapshotKey(inputs);
	const name = snapshotName(key);
	if (snapshotComplete(dir, name)) return ok({ avd, name, key, built: false });
	return withBuildLock(lockDeps(deps), androidGoldenLockKey(avd), () => ensureLocked(deps, avd, dir, key));
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
