import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { profileSlug } from "../allocate";
import { ensureUnlocked, systemReady } from "../android-keyguard";
import { biometricProfile, splitBiometricProfile } from "../biometrics";
import { DEFAULT_TTL_MS } from "../config.defaults";
import { type Exec, type ExecOptions, execError } from "../exec";
import { type PidAlive, processAlive } from "../liveness";
import { wardenHome } from "../store";
import type { InventoryDevice, Lease } from "../types";
import type { DeviceProvider, ProviderDeps } from "./provider.types";

/** Emulator console ports: even, 5554–5584; the adb port is console + 1. */
export const CONSOLE_PORT_MIN = 5554;
export const CONSOLE_PORT_MAX = 5584;

export type AndroidTools = { adb: string; emulator: string };

/** `adb`/`emulator` from `$ANDROID_HOME` / `$ANDROID_SDK_ROOT`, else bare PATH names. */
export function androidTools(env: Record<string, string | undefined>): AndroidTools {
	const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT;
	if (!sdk) return { adb: "adb", emulator: "emulator" };
	return { adb: join(sdk, "platform-tools", "adb"), emulator: join(sdk, "emulator", "emulator") };
}

export type AdbEmulator = { serial: string; port: number; state: string };

/** Parse `adb devices -l`, keeping only `emulator-<port>` serials (physical devices ignored). */
export function parseAdbDevices(stdout: string): AdbEmulator[] {
	const emulators: AdbEmulator[] = [];
	for (const line of stdout.split("\n")) {
		const match = /^(emulator-(\d+))\s+(\S+)/.exec(line.trim());
		if (match?.[1] && match[2] && match[3]) {
			emulators.push({ serial: match[1], port: Number(match[2]), state: match[3] });
		}
	}
	return emulators;
}

/** Parse `emulator -list-avds`, dropping the emulator's own `INFO | …` / `WARNING | …` log lines. */
export function parseAvdList(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.includes("|") && /^[\w.-]+$/.test(l));
}

/**
 * First even console port in 5554–5584 where neither the console port nor its adb port (+1) is in
 * `taken` (leased ports ∪ running emulator console/adb ports).
 */
export function pickConsolePort(taken: ReadonlySet<number>): number | undefined {
	for (let port = CONSOLE_PORT_MIN; port <= CONSOLE_PORT_MAX; port += 2) {
		if (!taken.has(port) && !taken.has(port + 1)) return port;
	}
	return undefined;
}

type ExecDeps = Pick<ProviderDeps, "exec" | "env">;

/** `adb emu …` talks to the emulator console, which a wedged emulator never answers. */
export const EMU_CONSOLE_TIMEOUT_MS = 10_000;
/** `emulator -list-avds` starts the emulator binary. */
export const LIST_AVDS_TIMEOUT_MS = 15_000;

/** Run a command; exec throwing (e.g. binary not found) becomes a failed result. */
async function run(deps: ExecDeps, cmd: readonly string[], opts?: ExecOptions): AsyncResult<string> {
	try {
		const result = await deps.exec(cmd, opts);
		return result.exitCode === 0 ? ok(result.stdout) : err(execError(cmd, result));
	} catch (error) {
		return err(`\`${cmd.join(" ")}\` failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Successful `-list-avds` per exec (one per process in the CLI) and emulator binary. */
const avdLists = new WeakMap<Exec, Map<string, Promise<Result<string[]>>>>();

/**
 * AVD names from `emulator -list-avds`, run once per process (per `exec`): a claim resolves `auto` and
 * then the AVD of each create from the same list. `fresh` re-reads it (an AVD made since); failures are
 * never kept.
 */
export async function listAvds(deps: ExecDeps, opts: { fresh?: boolean } = {}): AsyncResult<string[]> {
	const { emulator } = androidTools(deps.env);
	let lists = avdLists.get(deps.exec);
	if (lists === undefined) {
		lists = new Map();
		avdLists.set(deps.exec, lists);
	}
	const cached = opts.fresh === true ? undefined : lists.get(emulator);
	if (cached !== undefined) return cached;
	const pending = run(deps, [emulator, "-list-avds"], { timeoutMs: LIST_AVDS_TIMEOUT_MS }).then(
		(result): Result<string[]> => (result.success ? ok(parseAvdList(result.data)) : result)
	);
	lists.set(emulator, pending);
	const result = await pending;
	if (!result.success && lists.get(emulator) === pending) lists.delete(emulator);
	return result;
}

/** Running emulators from `adb devices -l`. */
export async function listEmulators(deps: ExecDeps): AsyncResult<AdbEmulator[]> {
	const { adb } = androidTools(deps.env);
	const result = await run(deps, [adb, "devices", "-l"]);
	return result.success ? ok(parseAdbDevices(result.data)) : result;
}

/** Launch `cmd` so it outlives warden, stdout/stderr appended to `logPath`. */
export type SpawnDetached = (cmd: readonly string[], logPath: string) => AsyncResult<{ pid: number }>;

export type AndroidProviderOptions = {
	spawnDetached?: SpawnDetached;
	sleep?: (ms: number) => Promise<void>;
	/** `sys.boot_completed` poll interval of the fallback loop, default 250 ms */
	pollIntervalMs?: number;
	/** how long the default `spawnDetached` watches for an immediate exit, default 1.5 s */
	earlyExitMs?: number;
	/** is the launched emulator process still alive (default: `kill -0`) */
	pidAlive?: PidAlive;
	/**
	 * Name of a warden quick-boot snapshot of `avd` to launch from (see `golden/android-golden.ts`), when
	 * one exists: a claim never builds one. `ok(undefined)` = none (off, not built yet, no SDK). A failure
	 * only logs: the emulator then cold-boots as before.
	 */
	snapshot?: (avd: string) => AsyncResult<string | undefined>;
	/** The emulator logged that `snapshot` of `avd` did not load (it cold-booted instead): drop it so it is rebuilt. */
	snapshotFailed?: (avd: string, snapshot: string) => AsyncResult<unknown>;
	/** The emulator launched from `snapshot` of `avd` and reached ready with no load failure logged. */
	snapshotLoaded?: (avd: string, snapshot: string) => void;
};

/** How often, and how long, `boot` looks for a just-launched warden emulator in `adb devices`. */
const REGISTER_POLL_MS = 250;
const REGISTER_TIMEOUT_MS = 15_000;

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One `adb shell` that returns once the guest has booted; POSIX `sh` (toybox `[`). */
export const BOOT_WAIT_SCRIPT = 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 0.2; done';
/** How often a boot wait checks that the launched emulator process is still alive. */
const LIVENESS_POLL_MS = 500;
/** Bound on one `getprop sys.boot_completed` read in the fallback loop. */
const PROP_READ_TIMEOUT_MS = 5_000;
/** `create` reuses the `adb devices` listing of an `inventory` this recent. */
const LISTING_REUSE_MS = 5_000;

function readLog(logPath: string, from = 0): string {
	try {
		return readFileSync(logPath).subarray(from).toString("utf8");
	} catch {
		return "";
	}
}

/** Bytes already in a log the next launch appends to: what it writes starts there. */
function logSize(logPath: string): number {
	try {
		return statSync(logPath).size;
	} catch {
		return 0;
	}
}

/** The last 3 lines of an emulator log, one line. */
export function logTail(logPath: string): string {
	return readLog(logPath).trim().split("\n").slice(-3).join(" | ");
}

/**
 * Default detached launcher: node `spawn` with `detached` + `unref` (own process group, so warden
 * exiting / Ctrl-C does not kill the emulator). Fails if the process exits within `earlyExitMs`.
 */
export function createSpawnDetached(earlyExitMs = 1_500): SpawnDetached {
	return async (cmd, logPath) => {
		const [file, ...args] = cmd;
		if (file === undefined) return err("empty command");
		let fd: number | undefined;
		try {
			fd = openSync(logPath, "a");
			const child = spawn(file, args, { detached: true, stdio: ["ignore", fd, fd] });
			const exited = new Promise<string>((resolve) => {
				child.once("error", (error) => resolve(error.message));
				child.once("exit", (code, signal) => resolve(`exited ${code ?? signal}`));
			});
			const outcome = await Promise.race([exited, defaultSleep(earlyExitMs).then(() => undefined)]);
			if (outcome !== undefined) {
				const tail = logTail(logPath);
				return err(`\`${cmd.join(" ")}\` ${outcome}${tail ? `: ${tail}` : ""} (log: ${logPath})`);
			}
			child.unref();
			if (child.pid === undefined) return err(`\`${cmd.join(" ")}\` did not start`);
			return ok({ pid: child.pid });
		} catch (error) {
			return err(error);
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	};
}

/** Cheap headless flags every warden emulator gets: no audio backend (unless `WARDEN_EMULATOR_AUDIO=1`), no usage metrics. */
export function headlessEmulatorFlags(env: Record<string, string | undefined>): string[] {
	return [...(env.WARDEN_EMULATOR_AUDIO === "1" ? [] : ["-no-audio"]), "-no-metrics"];
}

/** An early exit whose message says the emulator does not know one of its options (an older emulator). */
export function rejectedOption(error: string): boolean {
	return /unknown option|unrecognized option|invalid command-line (parameter|option)/i.test(error);
}

/** A claim's emulator: headless, `-read-only` (one AVD backs many), from `snapshot` when given, never saving on exit. */
export function claimEmulatorArgv(
	tools: AndroidTools,
	env: Record<string, string | undefined>,
	avd: string,
	port: number,
	snapshot?: string,
	/** `false` leaves out `headlessEmulatorFlags` (an emulator that rejected them) */
	headless = true
): string[] {
	return [
		tools.emulator,
		"-avd",
		avd,
		"-port",
		String(port),
		"-no-window",
		"-read-only",
		...(snapshot !== undefined ? ["-snapshot", snapshot] : []),
		"-no-snapshot-save",
		"-no-boot-anim",
		...(headless ? headlessEmulatorFlags(env) : []),
	];
}

export type BootWaitDeps = ExecDeps & {
	now: () => number;
	sleep: (ms: number) => Promise<void>;
	pidAlive: PidAlive;
	/** fallback `getprop` poll interval */
	pollIntervalMs: number;
};

/** The launched emulator process, when known: a boot wait fails as soon as it is gone. */
export type BootWatch = { pid?: number; logPath?: string };

/** Fallback when the one-shot shell fails (adbd restarting mid-boot): `wait-for-device`, then bounded `getprop` reads. */
async function pollBootCompleted(
	deps: BootWaitDeps,
	serial: string,
	deadline: number,
	signal: AbortSignal
): AsyncResult<void> {
	const { adb } = androidTools(deps.env);
	const remaining = () => Math.max(1, deadline - deps.now());
	const waited = await run(deps, [adb, "-s", serial, "wait-for-device"], { timeoutMs: remaining(), signal });
	if (!waited.success) return waited;
	while (!signal.aborted) {
		const prop = await run(deps, [adb, "-s", serial, "shell", "getprop", "sys.boot_completed"], {
			timeoutMs: Math.min(PROP_READ_TIMEOUT_MS, remaining()),
			signal,
		});
		if (prop.success && prop.data.trim() === "1") return ok(undefined);
		if (deps.now() >= deadline) break;
		await deps.sleep(deps.pollIntervalMs);
	}
	return err("boot wait stopped");
}

/** Every 0.5 s until `signal` aborts: fail once the launched emulator is gone or the deadline passed. */
async function watchBoot(
	deps: BootWaitDeps,
	serial: string,
	deadline: number,
	watch: BootWatch,
	signal: AbortSignal,
	timedOut: () => Result<void>
): AsyncResult<void> {
	while (!signal.aborted) {
		await deps.sleep(LIVENESS_POLL_MS);
		if (signal.aborted) break;
		if (watch.pid !== undefined && !deps.pidAlive(watch.pid))
			return err(emulatorExited(serial, watch.pid, watch.logPath));
		if (deps.now() >= deadline) return timedOut();
	}
	return err("boot wait stopped");
}

function emulatorExited(serial: string, pid: number, logPath: string | undefined): string {
	const tail = logPath !== undefined ? logTail(logPath) : "";
	const where = logPath !== undefined ? ` (log: ${logPath})` : "";
	return `${serial}: the emulator (pid ${pid}) exited while booting${tail ? `: ${tail}` : ""}${where}`;
}

/**
 * Wait for `sys.boot_completed=1` within `timeoutMs`: one `adb wait-for-device shell <loop>` bounded by
 * the budget (falling back to a bounded poll when it fails early), raced against the deadline and the
 * emulator process staying alive, so a dead emulator fails in ≤ 0.5 s with its log tail instead of
 * waiting out the budget. Whatever is still running when it settles is aborted.
 */
export async function waitBootCompleted(
	deps: BootWaitDeps,
	serial: string,
	timeoutMs: number,
	watch: BootWatch = {}
): AsyncResult<void> {
	const { adb } = androidTools(deps.env);
	const deadline = deps.now() + timeoutMs;
	const abort = new AbortController();
	const timedOut = (): Result<void> => err(`timed out after ${timeoutMs}ms waiting for ${serial} to finish booting`);
	const wait = (async (): AsyncResult<void> => {
		const once = await run(deps, [adb, "-s", serial, "wait-for-device", "shell", BOOT_WAIT_SCRIPT], {
			timeoutMs,
			signal: abort.signal,
		});
		if (once.success) return ok(undefined);
		if (abort.signal.aborted) return once;
		if (deps.now() >= deadline) return timedOut();
		const polled = await pollBootCompleted(deps, serial, deadline, abort.signal);
		return polled.success || deps.now() < deadline ? polled : timedOut();
	})();
	const watcher = watchBoot(deps, serial, deadline, watch, abort.signal, timedOut);
	try {
		return await Promise.race([wait, watcher]);
	} finally {
		abort.abort();
	}
}

/**
 * Take a console-port lease (`emulator <name>`) under the store's cross-process lock: the first even
 * port whose console and adb ports are neither leased nor used by a running emulator.
 */
export function leaseConsolePort(
	deps: Pick<ProviderDeps, "store" | "owner" | "now">,
	name: string,
	running: AdbEmulator[]
): Result<{ lease: Lease; port: number }> {
	return deps.store.transaction(() => {
		const taken = new Set<number>();
		for (const lease of deps.store.listLeases()) {
			if (lease.resource.kind === "port") taken.add(lease.resource.port);
		}
		for (const emu of running) {
			taken.add(emu.port);
			taken.add(emu.port + 1);
		}
		const port = pickConsolePort(taken);
		if (port === undefined) {
			return err(`no free emulator console port in ${CONSOLE_PORT_MIN}-${CONSOLE_PORT_MAX}`);
		}
		const lease = deps.store.insertLease(
			{ resource: { kind: "port", port }, owner: deps.owner, ttlMs: DEFAULT_TTL_MS, label: `emulator ${name}` },
			deps.now()
		);
		return ok({ lease, port });
	});
}

function missingEnrolledSnapshot(profile: string): string {
	return `profile ${profile} needs its enrolled snapshot, but none is available (android snapshots off, no SDK root, or the build failed); build it with: warden golden ensure --platform android --profile ${profile}`;
}

/** Label prefix of the console-port lease a snapshot build's writable emulator runs on. */
export const GOLDEN_PORT_LABEL = "emulator golden ";

/**
 * A snapshot load the emulator gave up on (it then cold-boots by itself). The wording is the emulator's
 * and unverified on a device; a successful load logs `Successfully loaded snapshot …`, which does not match.
 */
export function snapshotLoadFailed(log: string): boolean {
	return /(fail|error|cannot|could not|unable|does not have)[^\n]*snapshot|snapshot[^\n]*(fail|not found|does not exist|could not|invalid|error)/i.test(
		log
	);
}

function serialPort(serial: string): number | undefined {
	const match = /^emulator-(\d+)$/.exec(serial);
	return match?.[1] ? Number(match[1]) : undefined;
}

function isEmulatorPortLease(lease: Lease | undefined): lease is Lease {
	return lease?.resource.kind === "port" && (lease.label?.startsWith("emulator ") ?? false);
}

/**
 * Global settings applied after every boot. On a fresh playstore image the first `adb install` can pop a Play
 * Protect consent dialog (a GMS activity the e2e alert detector cannot classify), and every adb install otherwise
 * waits on the GMS verifier (up to the 10 s verifier_timeout). Warden's emulators run `-read-only -no-snapshot-save`,
 * so /data changes are a per-boot overlay and must be re-applied on each boot.
 */
export const BOOT_SETTINGS: ReadonlyArray<readonly [key: string, value: string]> = [
	["package_verifier_user_consent", "-1"],
	["verifier_verify_adb_installs", "0"],
	["package_verifier_enable", "0"],
];

export function bootSettingsCommand(): string {
	return BOOT_SETTINGS.map(([key, value]) => `settings put global ${key} ${value}`).join("; ");
}

/** Bound on each of the system-ready waits around the unlock of a biometrics emulator. */
const SYSTEM_READY_MS = 60_000;
const SETTLED_READY_MS = 15_000;

/**
 * Android emulators on `adb` + `emulator`. Warden never boots an existing emulator — it launches a
 * new headless `-read-only` instance of an AVD (so one AVD backs many emulators) on a leased even
 * console port, and only kills emulators it launched (store `devices` table).
 */
export function createAndroidProvider(deps: ProviderDeps, options: AndroidProviderOptions = {}): DeviceProvider {
	const tools = androidTools(deps.env);
	const sleep = options.sleep ?? defaultSleep;
	const pollIntervalMs = options.pollIntervalMs ?? 250;
	const pidAlive = options.pidAlive ?? processAlive;
	const spawnDetached = options.spawnDetached ?? createSpawnDetached(options.earlyExitMs);
	/** emulators this provider launched: the boot wait watches their pid */
	type Launch = { pid: number; logPath: string; logOffset: number; avd: string; snapshot?: string };
	const launches = new Map<string, Launch>();
	/** the last inventory's `adb devices`, reused by a `create` right after it */
	let lastListing: { at: number; emulators: AdbEmulator[] } | undefined;

	/**
	 * A biometrics emulator (by its launch, or by its recorded profile when warden reuses one) must be past its PIN
	 * lock screen and have adb + the package manager answering before anything installs.
	 */
	async function settleBiometricsDevice(id: string, avd: string | undefined): AsyncResult<void> {
		const recorded = deps.store.listDevices("android").find((d) => d.id === id);
		if (recorded === undefined || !splitBiometricProfile(avd ?? recorded.profile ?? "").biometrics)
			return ok(undefined);
		const keyguard = { exec: deps.exec, sleep, adb: tools.adb, now: deps.now };
		const up = await systemReady(keyguard, id, SYSTEM_READY_MS);
		if (!up.success) return up;
		const unlocked = await ensureUnlocked(keyguard, id);
		if (!unlocked.success) return unlocked;
		// the unlock and the snapshot restore can leave adb flapping offline; an install right after would fail
		return systemReady(keyguard, id, SETTLED_READY_MS);
	}

	const adb = (serial: string, ...args: string[]): readonly string[] => [tools.adb, "-s", serial, ...args];

	/** `emu avd name`, bounded; `hung` = the console did not answer in time. */
	async function avdNameOf(serial: string): Promise<{ name?: string; hung: boolean }> {
		const started = deps.now();
		const avd = await run(deps, adb(serial, "emu", "avd", "name"), { timeoutMs: EMU_CONSOLE_TIMEOUT_MS });
		if (avd.success) return { name: avd.data.split("\n")[0]?.trim(), hung: false };
		return { hung: deps.now() - started >= EMU_CONSOLE_TIMEOUT_MS };
	}

	async function describeEmulator(
		emu: AdbEmulator,
		recordedName: string | undefined,
		golden: boolean
	): Promise<InventoryDevice> {
		const online = emu.state === "device";
		const [avd, sdk] = await Promise.all([
			avdNameOf(emu.serial),
			online ? run(deps, adb(emu.serial, "shell", "getprop", "ro.build.version.sdk")) : Promise.resolve(err("offline")),
		]);
		const avdName = avd.name;
		// a console that does not answer is not a usable emulator yet: booting, no profile, the round goes on
		const booted = online && !avd.hung;
		const device: InventoryDevice = {
			platform: "android",
			id: emu.serial,
			name: recordedName ?? (avdName || emu.serial),
			state: booted ? "booted" : "booting",
			wardenCreated: false,
		};
		if (golden) device.golden = true;
		if (avdName) device.profile = profileSlug(avdName);
		const level = sdk.success ? sdk.data.trim() : "";
		if (/^\d+$/.test(level)) device.runtime = `android-${level}`;
		return device;
	}

	/** The AVD whose `profileSlug` is `profile` (the per-process list, re-read once on a miss). */
	async function resolveAvd(profile: string): AsyncResult<string> {
		let avds = await listAvds(deps);
		if (avds.success && !avds.data.some((a) => profileSlug(a) === profile))
			avds = await listAvds(deps, { fresh: true });
		if (!avds.success) return avds;
		const avd = avds.data.find((a) => profileSlug(a) === profile);
		if (avd !== undefined) return ok(avd);
		const available = avds.data.map((a) => `${profileSlug(a)} (${a})`).join(", ") || "none";
		return err(`no AVD matches profile "${profile}"; available: ${available}`);
	}

	/** Warden's snapshot of `avd`, if any; a failure to make one is logged, not fatal. */
	async function snapshotFor(avd: string): Promise<string | undefined> {
		if (options.snapshot === undefined) return undefined;
		const snapshot = await options.snapshot(avd);
		if (snapshot.success) return snapshot.data;
		deps.log?.(`no quick-boot snapshot for ${avd} (${snapshot.error}) — cold boot`);
		return undefined;
	}

	async function shutdownDevice(id: string): AsyncResult<void> {
		if (!deps.store.listDevices("android").some((d) => d.id === id)) {
			return err(`refusing to shut down foreign emulator ${id}`);
		}
		const killed = await run(deps, adb(id, "emu", "kill"), { timeoutMs: EMU_CONSOLE_TIMEOUT_MS });
		if (!killed.success) {
			const emulators = await listEmulators(deps);
			if (!emulators.success || emulators.data.some((e) => e.serial === id)) return killed;
		}
		const port = serialPort(id);
		deps.store.transaction(() => {
			if (port !== undefined) {
				const lease = deps.store.findLeaseByResource({ kind: "port", port });
				if (isEmulatorPortLease(lease)) deps.store.deleteLeases([lease.id]);
			}
			deps.store.forgetDevice("android", id);
		});
		return ok(undefined);
	}

	/** A device that never got ready (locked, adb offline) must not be left up for the next claim to reuse; foreign ones are left alone. */
	async function discardUnready(id: string): Promise<void> {
		if (deps.store.listDevices("android").some((d) => d.id === id)) await shutdownDevice(id);
	}

	/** Whether a snapshot launch loaded or fell back to a cold boot, reported to the snapshot bookkeeping. */
	async function noteSnapshotOutcome(id: string, launched: Launch | undefined) {
		const snapshot = launched?.snapshot;
		if (!launched || !snapshot) return;
		if (!snapshotLoadFailed(readLog(launched.logPath, launched.logOffset))) {
			options.snapshotLoaded?.(launched.avd, snapshot);
			return;
		}
		deps.log?.(`${id}: snapshot ${snapshot} did not load, the emulator cold-booted (log: ${launched.logPath})`);
		const dropped = await options.snapshotFailed?.(launched.avd, snapshot);
		if (dropped && !dropped.success) deps.log?.(`${id}: snapshot ${snapshot} kept: ${dropped.error}`);
	}

	/** The AVD, snapshot target and snapshot a `profile` launches from. */
	async function resolveLaunchTarget(
		profile: string
	): AsyncResult<{ avdName: string; target: string; snapshot: string | undefined }> {
		const split = splitBiometricProfile(profile);
		const resolved = await resolveAvd(split.profile);
		if (!resolved.success) return resolved;
		// a biometrics profile is a separate golden of the AVD; its devices must start enrolled, so no cold-boot fallback
		const target = biometricProfile(resolved.data, split.biometrics);
		const snapshot = await snapshotFor(target);
		if (split.biometrics && snapshot === undefined) return err(missingEnrolledSnapshot(profile));
		return ok({ avdName: resolved.data, target, snapshot });
	}

	/** Launch a headless, read-only emulator of `avd` on `port`, logging to `$WARDEN_HOME/logs/<serial>.log`. */
	async function launch(
		avd: string,
		port: number,
		serial: string,
		snapshot: string | undefined,
		headless: boolean
	): AsyncResult<{ pid: number; logPath: string; logOffset: number }> {
		const logDir = join(wardenHome(deps.env), "logs");
		try {
			mkdirSync(logDir, { recursive: true });
		} catch (error) {
			return err(error);
		}
		const logPath = join(logDir, `${serial}.log`);
		const logOffset = logSize(logPath);
		const argv = claimEmulatorArgv(tools, deps.env, avd, port, snapshot, headless);
		const spawned = await spawnDetached(argv, logPath);
		return spawned.success ? ok({ pid: spawned.data.pid, logPath, logOffset }) : spawned;
	}

	/** `adb devices` for a create: the last inventory's when it is recent (the claim's own), else a fresh one. */
	async function runningEmulators(): AsyncResult<AdbEmulator[]> {
		if (lastListing !== undefined && deps.now() - lastListing.at <= LISTING_REUSE_MS) return ok(lastListing.emulators);
		return listEmulators(deps);
	}

	/**
	 * Launch from `snapshot`; if that launch fails, once more with today's cold-boot argv. An emulator that
	 * rejects the headless flags (too old for `-no-metrics`) is relaunched once without them.
	 */
	async function launchOrColdBoot(
		avd: string,
		port: number,
		serial: string,
		snapshot: string | undefined
	): AsyncResult<{ pid: number; logPath: string; logOffset: number; snapshot?: string }> {
		let headless = true;
		const attempt = async (from: string | undefined) => {
			const first = await launch(avd, port, serial, from, headless);
			if (first.success || !headless || !rejectedOption(first.error)) return first;
			headless = false;
			deps.log?.(
				`${serial}: the emulator rejected ${headlessEmulatorFlags(deps.env).join(" ")} — relaunching without them`
			);
			return launch(avd, port, serial, from, false);
		};
		const launched = await attempt(snapshot);
		if (launched.success) return snapshot !== undefined ? ok({ ...launched.data, snapshot }) : launched;
		if (snapshot === undefined) return launched;
		deps.log?.(`${serial}: launch from snapshot ${snapshot} failed (${launched.error}) — retrying with a cold boot`);
		return attempt(undefined);
	}

	return {
		platform: "android",

		async inventory() {
			const emulators = await listEmulators(deps);
			if (!emulators.success) return emulators;
			lastListing = { at: deps.now(), emulators: emulators.data };
			const recorded = new Map(deps.store.listDevices("android").map((r) => [r.id, r.name]));
			const goldenPorts = new Set(
				deps.store
					.listLeases()
					.flatMap((l) =>
						l.resource.kind === "port" && l.label?.startsWith(GOLDEN_PORT_LABEL) ? [l.resource.port] : []
					)
			);
			const known = emulators.data.filter((e) => e.state === "device" || e.state === "offline");
			return ok(
				await Promise.all(known.map((e) => describeEmulator(e, recorded.get(e.serial), goldenPorts.has(e.port))))
			);
		},

		async create(name, profile, runtime) {
			const resolved = await resolveLaunchTarget(profile);
			if (!resolved.success) return resolved;
			const { avdName, target, snapshot } = resolved.data;
			const running = await runningEmulators();
			if (!running.success) return running;

			const leased = leaseConsolePort(deps, name, running.data);
			if (!leased.success) return leased;
			const { lease, port } = leased.data;
			const serial = `emulator-${port}`;
			const launched = await launchOrColdBoot(avdName, port, serial, snapshot);
			if (!launched.success) {
				deps.store.deleteLeases([lease.id]);
				return launched;
			}
			launches.set(serial, { ...launched.data, avd: target });

			const recordedRuntime = runtime !== undefined && runtime !== "latest" ? runtime : undefined;
			deps.store.recordDevice({ platform: "android", id: serial, name, profile, runtime: recordedRuntime }, deps.now());
			const device: InventoryDevice = {
				platform: "android",
				id: serial,
				name,
				state: "booting",
				wardenCreated: true,
				profile,
			};
			if (recordedRuntime !== undefined) device.runtime = recordedRuntime;
			return ok(device);
		},

		async boot(id) {
			// A warden emulator `create` just launched may not have reached the adb server yet: poll for it.
			const launched = deps.store.listDevices("android").some((d) => d.id === id);
			const polls = launched ? Math.ceil(REGISTER_TIMEOUT_MS / REGISTER_POLL_MS) : 0;
			for (let i = 0; ; i++) {
				const emulators = await listEmulators(deps);
				if (!emulators.success) return emulators;
				if (emulators.data.some((e) => e.serial === id)) return ok(undefined);
				if (i >= polls) break;
				await sleep(REGISTER_POLL_MS);
			}
			return launched
				? err(`${id} did not register with adb within ${REGISTER_TIMEOUT_MS / 1000}s of its launch`)
				: err(`${id} is not running — android devices are created, not booted`);
		},

		async waitReady(id, timeoutMs) {
			const launched = launches.get(id);
			const booted = await waitBootCompleted({ ...deps, sleep, pidAlive, pollIntervalMs }, id, timeoutMs, launched);
			if (booted.success) await run(deps, adb(id, "shell", bootSettingsCommand()));
			const ready = booted.success ? await settleBiometricsDevice(id, launched?.avd) : booted;
			if (!ready.success) await discardUnready(id);
			else await noteSnapshotOutcome(id, launched);
			return ready;
		},

		shutdown: shutdownDevice,
	};
}
