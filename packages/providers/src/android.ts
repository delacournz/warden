import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TTL_MS } from "@delacour/warden-config/config.defaults";
import { type Exec, type ExecOptions, execErrors } from "@delacour/warden-runtime/exec";
import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import { storeLocator } from "@delacour/warden-store/store";
import type { InventoryDevice, Lease } from "@delacour/warden-store/types";
import { leaseModel } from "@delacour/warden-store/types";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { AndroidKeyguard } from "./android-keyguard";
import { type AndroidTools, androidToolsLocator } from "./android-tools";
import { biometricProfiles } from "./biometrics";
import { BaseDeviceProvider, type RefusedVerb } from "./device-provider";
import type { ProviderDeps } from "./provider.types";

/** Emulator console ports: even, 5554–5584; the adb port is console + 1. */
export const CONSOLE_PORT_MIN = 5554;
export const CONSOLE_PORT_MAX = 5584;

export type AdbEmulator = { serial: string; port: number; state: string };

/** One `adb devices -l` row: a console emulator, or anything else (a phone, or a network emulator until `classifyOther`). */
export type AdbListEntry =
	| ({ kind: "emulator" } & AdbEmulator)
	| {
			kind: "other";
			serial: string;
			state: string;
			transport: "usb" | "wifi";
			model?: string;
			product?: string;
	  };

/** Reads `adb` and `emulator` output, and the console-port arithmetic. */
export class AdbParser {
	/**
	 * Parse `adb devices -l`. A state may be several words (`no permissions (…); see [url]`), so the state is
	 * the first token unless the row says `no permissions`. Transport: a `usb:` attribute is usb; `ip:port` and
	 * `_adb-tls-connect._tcp` serials (and anything else without `usb:`) are wifi.
	 */
	parseDeviceList(stdout: string): AdbListEntry[] {
		const entries: AdbListEntry[] = [];
		for (const raw of stdout.split("\n")) {
			const entry = this.parseRow(raw.trim());
			if (entry) entries.push(entry);
		}
		return entries;
	}

	/** Parse `adb devices -l`, keeping only `emulator-<port>` serials (phones and network emulators ignored). */
	parseEmulators(stdout: string): AdbEmulator[] {
		const emulators: AdbEmulator[] = [];
		for (const entry of this.parseDeviceList(stdout)) {
			if (entry.kind === "emulator") emulators.push({ serial: entry.serial, port: entry.port, state: entry.state });
		}
		return emulators;
	}

	/** Parse `emulator -list-avds`, dropping the emulator's own `INFO | …` / `WARNING | …` log lines. */
	parseAvdList(stdout: string): string[] {
		return stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.includes("|") && /^[\w.-]+$/.test(l));
	}

	/**
	 * First even console port in 5554–5584 where neither the console port nor its adb port (+1) is in
	 * `taken` (leased ports ∪ running emulator console/adb ports).
	 */
	pickConsolePort(taken: ReadonlySet<number>): number | undefined {
		for (let port = CONSOLE_PORT_MIN; port <= CONSOLE_PORT_MAX; port += 2) {
			if (!taken.has(port) && !taken.has(port + 1)) return port;
		}
		return undefined;
	}

	/** Is `id` a console emulator serial; anything else is a phone (or a network emulator), which warden never boots, kills or writes settings to. */
	isEmulatorSerial(id: string): boolean {
		return /^emulator-\d+$/.test(id);
	}

	serialPort(serial: string): number | undefined {
		const match = /^emulator-(\d+)$/.exec(serial);
		return match?.[1] ? Number(match[1]) : undefined;
	}

	private parseRow(line: string): AdbListEntry | undefined {
		const row = /^(\S+)\s+(.+)$/.exec(line);
		if (!row?.[1] || !row[2] || line.startsWith("List of devices") || line.startsWith("*")) return undefined;
		const serial = row[1];
		const rest = row[2];
		const noPermissions = rest.startsWith("no permissions");
		const state = noPermissions ? "no permissions" : (rest.split(/\s+/)[0] ?? "");
		const emulator = /^emulator-(\d+)$/.exec(serial);
		if (emulator?.[1]) return { kind: "emulator", serial, port: Number(emulator[1]), state };
		const attributes = noPermissions ? rest.slice(rest.lastIndexOf("]") + 1) : rest.slice(state.length);
		const attr = (key: string): string | undefined => new RegExp(`(?:^|\\s)${key}:(\\S+)`).exec(attributes)?.[1];
		const networked = /^[^:\s]+:\d+$|_adb-tls-/.test(serial);
		const model = attr("model");
		const product = attr("product");
		return {
			kind: "other",
			serial,
			state,
			transport: networked ? "wifi" : "usb",
			...(model !== undefined ? { model } : {}),
			...(product !== undefined ? { product } : {}),
		};
	}
}

export const adbParser = new AdbParser();

type ExecDeps = Pick<ProviderDeps, "exec" | "env">;

/** `adb emu …` talks to the emulator console, which a wedged emulator never answers. */
export const EMU_CONSOLE_TIMEOUT_MS = 10_000;
/** `emulator -list-avds` starts the emulator binary. */
export const LIST_AVDS_TIMEOUT_MS = 15_000;

/** One `adb shell` that returns once the guest has booted; POSIX `sh` (toybox `[`). */
export const BOOT_WAIT_SCRIPT = 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 0.2; done';
/** How often a boot wait checks that the launched emulator process is still alive. */
const LIVENESS_POLL_MS = 500;
/** Bound on one `getprop sys.boot_completed` read in the fallback loop. */
const PROP_READ_TIMEOUT_MS = 5_000;
/** One shell: qemu props (emulator tell-tales), hardware serial, model, SDK level — one value per line. */
export const PHONE_PROBE_SCRIPT =
	"getprop ro.boot.qemu; getprop ro.kernel.qemu; getprop ro.serialno; getprop ro.product.model; getprop ro.build.version.sdk";
/** `create` reuses the `adb devices` listing of an `inventory` this recent. */
const LISTING_REUSE_MS = 5_000;

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

/** Label prefix of the console-port lease a snapshot build's writable emulator runs on. */
export const GOLDEN_PORT_LABEL = "emulator golden ";

/** The `emulator` command line warden launches, and what its early exits mean. */
export class EmulatorArgv {
	/** Cheap headless flags every warden emulator gets: no audio backend (unless `WARDEN_EMULATOR_AUDIO=1`), no usage metrics. */
	headlessFlags(env: Record<string, string | undefined>): string[] {
		return [...(env.WARDEN_EMULATOR_AUDIO === "1" ? [] : ["-no-audio"]), "-no-metrics"];
	}

	/** An early exit whose message says the emulator does not know one of its options (an older emulator). */
	rejectedOption(error: string): boolean {
		return /unknown option|unrecognized option|invalid command-line (parameter|option)/i.test(error);
	}

	/** A claim's emulator: headless, `-read-only` (one AVD backs many), from `snapshot` when given, never saving on exit. */
	claim(
		tools: AndroidTools,
		env: Record<string, string | undefined>,
		avd: string,
		port: number,
		snapshot?: string,
		/** `false` leaves out `headlessFlags` (an emulator that rejected them) */
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
			...(headless ? this.headlessFlags(env) : []),
		];
	}

	bootSettingsCommand(): string {
		return BOOT_SETTINGS.map(([key, value]) => `settings put global ${key} ${value}`).join("; ");
	}
}

export const emulatorArgv = new EmulatorArgv();

/** The log a launched emulator appends to. */
export class EmulatorLog {
	read(logPath: string, from = 0): string {
		try {
			return readFileSync(logPath).subarray(from).toString("utf8");
		} catch {
			return "";
		}
	}

	/** Bytes already in a log the next launch appends to: what it writes starts there. */
	size(logPath: string): number {
		try {
			return statSync(logPath).size;
		} catch {
			return 0;
		}
	}

	/** The last 3 lines of an emulator log, one line. */
	tail(logPath: string): string {
		return this.read(logPath).trim().split("\n").slice(-3).join(" | ");
	}

	/**
	 * A snapshot load the emulator gave up on (it then cold-boots by itself). The wording is the emulator's
	 * and unverified on a device; a successful load logs `Successfully loaded snapshot …`, which does not match.
	 */
	snapshotLoadFailed(log: string): boolean {
		return /(fail|error|cannot|could not|unable|does not have)[^\n]*snapshot|snapshot[^\n]*(fail|not found|does not exist|could not|invalid|error)/i.test(
			log
		);
	}

	exited(serial: string, pid: number, logPath: string | undefined): string {
		const tail = logPath !== undefined ? this.tail(logPath) : "";
		const where = logPath !== undefined ? ` (log: ${logPath})` : "";
		return `${serial}: the emulator (pid ${pid}) exited while booting${tail ? `: ${tail}` : ""}${where}`;
	}
}

export const emulatorLog = new EmulatorLog();

/** Timers for waits that are not part of a deadline. */
export class Sleeper {
	readonly sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
}

export const sleeper = new Sleeper();

/** Launch `cmd` so it outlives warden, stdout/stderr appended to `logPath`. */
export type SpawnDetached = (cmd: readonly string[], logPath: string) => AsyncResult<{ pid: number }>;

/**
 * Default detached launcher: node `spawn` with `detached` + `unref` (own process group, so warden
 * exiting / Ctrl-C does not kill the emulator). Fails if the process exits within `earlyExitMs`.
 */
export class DetachedSpawner {
	constructor(private readonly earlyExitMs = 1_500) {}

	readonly spawn: SpawnDetached = async (cmd, logPath) => {
		const [file, ...args] = cmd;
		if (file === undefined) return resultFactory.err("empty command");
		let fd: number | undefined;
		try {
			fd = openSync(logPath, "a");
			const child = spawn(file, args, { detached: true, stdio: ["ignore", fd, fd] });
			const exited = new Promise<string>((resolve) => {
				child.once("error", (error) => resolve(error.message));
				child.once("exit", (code, signal) => resolve(`exited ${code ?? signal}`));
			});
			const outcome = await Promise.race([exited, sleeper.sleep(this.earlyExitMs).then(() => undefined)]);
			if (outcome !== undefined) {
				const tail = emulatorLog.tail(logPath);
				return resultFactory.err(`\`${cmd.join(" ")}\` ${outcome}${tail ? `: ${tail}` : ""} (log: ${logPath})`);
			}
			child.unref();
			if (child.pid === undefined) return resultFactory.err(`\`${cmd.join(" ")}\` did not start`);
			return resultFactory.ok({ pid: child.pid });
		} catch (error) {
			return resultFactory.err(error);
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	};
}

/** Successful `-list-avds` per exec (one per process in the CLI) and emulator binary. */
export class AvdListCache {
	private readonly lists = new WeakMap<Exec, Map<string, Promise<Result<string[], WardenError>>>>();

	for(exec: Exec): Map<string, Promise<Result<string[], WardenError>>> {
		let lists = this.lists.get(exec);
		if (lists === undefined) {
			lists = new Map();
			this.lists.set(exec, lists);
		}
		return lists;
	}
}

export const avdListCache = new AvdListCache();

export type OtherClass = { emulator: boolean; hwSerial?: string; model?: string; sdk?: string };

/** `adb` and `emulator` listings through `exec`. */
export class Adb {
	constructor(
		private readonly deps: ExecDeps,
		private readonly cache: AvdListCache = avdListCache
	) {}

	/** Run a command; exec throwing (e.g. binary not found) becomes a failed result. */
	async run(cmd: readonly string[], opts?: ExecOptions): AsyncResult<string, WardenError> {
		try {
			const result = await this.deps.exec(cmd, opts);
			return result.exitCode === 0
				? resultFactory.ok(result.stdout)
				: wardenErrors.err("failed", execErrors.format(cmd, result));
		} catch (error) {
			return wardenErrors.err(
				"failed",
				`\`${cmd.join(" ")}\` failed: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	/**
	 * AVD names from `emulator -list-avds`, run once per process (per `exec`): a claim resolves `auto` and
	 * then the AVD of each create from the same list. `fresh` re-reads it (an AVD made since); failures are
	 * never kept.
	 */
	async listAvds(opts: { fresh?: boolean } = {}): AsyncResult<string[], WardenError> {
		const { emulator } = androidToolsLocator.locate(this.deps.env);
		const lists = this.cache.for(this.deps.exec);
		const cached = opts.fresh === true ? undefined : lists.get(emulator);
		if (cached !== undefined) return cached;
		const pending = this.run([emulator, "-list-avds"], { timeoutMs: LIST_AVDS_TIMEOUT_MS }).then(
			(result): Result<string[], WardenError> =>
				result.success ? resultFactory.ok(adbParser.parseAvdList(result.data)) : result
		);
		lists.set(emulator, pending);
		const result = await pending;
		if (!result.success && lists.get(emulator) === pending) lists.delete(emulator);
		return result;
	}

	/** Every row of `adb devices -l`: emulators, phones and network emulators. */
	async listDevices(): AsyncResult<AdbListEntry[], WardenError> {
		const result = await this.devicesOutput();
		return result.success ? resultFactory.ok(adbParser.parseDeviceList(result.data)) : result;
	}

	/** Running emulators from `adb devices -l`. */
	async listEmulators(): AsyncResult<AdbEmulator[], WardenError> {
		const result = await this.devicesOutput();
		return result.success ? resultFactory.ok(adbParser.parseEmulators(result.data)) : result;
	}

	/**
	 * Is a non-`emulator-N` adb serial a real phone? `localhost:5555` / Genymotion / a network emulator set
	 * `ro.boot.qemu` or `ro.kernel.qemu` to 1: a foreign emulator, never physical. One bounded read; a failure
	 * is an error, not a guess.
	 */
	async classifyOther(serial: string): AsyncResult<OtherClass, WardenError> {
		const { adb } = androidToolsLocator.locate(this.deps.env);
		const read = await this.run([adb, "-s", serial, "shell", PHONE_PROBE_SCRIPT], {
			timeoutMs: PROP_READ_TIMEOUT_MS,
		});
		if (!read.success) return read;
		const [bootQemu, kernelQemu, hw, model, sdk] = read.data.split("\n").map((l) => l.replace(/\r$/, "").trim());
		const info: OtherClass = { emulator: bootQemu === "1" || kernelQemu === "1" };
		if (hw) info.hwSerial = hw;
		if (model) info.model = model;
		if (sdk && /^\d+$/.test(sdk)) info.sdk = sdk;
		return resultFactory.ok(info);
	}

	private devicesOutput(): AsyncResult<string, WardenError> {
		const { adb } = androidToolsLocator.locate(this.deps.env);
		return this.run([adb, "devices", "-l"]);
	}
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

/** Waits for `sys.boot_completed=1` of one emulator. */
export class BootWaiter {
	private readonly adb: Adb;

	constructor(private readonly deps: BootWaitDeps) {
		this.adb = new Adb(deps);
	}

	/**
	 * Wait for `sys.boot_completed=1` within `timeoutMs`: one `adb wait-for-device shell <loop>` bounded by
	 * the budget (falling back to a bounded poll when it fails early), raced against the deadline and the
	 * emulator process staying alive, so a dead emulator fails in ≤ 0.5 s with its log tail instead of
	 * waiting out the budget. Whatever is still running when it settles is aborted.
	 */
	async wait(serial: string, timeoutMs: number, watch: BootWatch = {}): AsyncResult<void, WardenError> {
		const deadline = this.deps.now() + timeoutMs;
		const abort = new AbortController();
		const timedOut = (): Result<void, WardenError> =>
			wardenErrors.err("timeout", `timed out after ${timeoutMs}ms waiting for ${serial} to finish booting`, {
				retryable: true,
			});
		const wait = this.waitOrPoll(serial, timeoutMs, deadline, abort.signal, timedOut);
		const watcher = this.watchBoot(serial, deadline, watch, abort.signal, timedOut);
		try {
			return await Promise.race([wait, watcher]);
		} finally {
			abort.abort();
		}
	}

	private async waitOrPoll(
		serial: string,
		timeoutMs: number,
		deadline: number,
		signal: AbortSignal,
		timedOut: () => Result<void, WardenError>
	): AsyncResult<void, WardenError> {
		const { adb } = androidToolsLocator.locate(this.deps.env);
		const once = await this.adb.run([adb, "-s", serial, "wait-for-device", "shell", BOOT_WAIT_SCRIPT], {
			timeoutMs,
			signal,
		});
		if (once.success) return resultFactory.ok(undefined);
		if (signal.aborted) return once;
		if (this.deps.now() >= deadline) return timedOut();
		const polled = await this.pollBootCompleted(serial, deadline, signal);
		return polled.success || this.deps.now() < deadline ? polled : timedOut();
	}

	/** Fallback when the one-shot shell fails (adbd restarting mid-boot): `wait-for-device`, then bounded `getprop` reads. */
	private async pollBootCompleted(
		serial: string,
		deadline: number,
		signal: AbortSignal
	): AsyncResult<void, WardenError> {
		const { adb } = androidToolsLocator.locate(this.deps.env);
		const remaining = () => Math.max(1, deadline - this.deps.now());
		const waited = await this.adb.run([adb, "-s", serial, "wait-for-device"], { timeoutMs: remaining(), signal });
		if (!waited.success) return waited;
		while (!signal.aborted) {
			const prop = await this.adb.run([adb, "-s", serial, "shell", "getprop", "sys.boot_completed"], {
				timeoutMs: Math.min(PROP_READ_TIMEOUT_MS, remaining()),
				signal,
			});
			if (prop.success && prop.data.trim() === "1") return resultFactory.ok(undefined);
			if (this.deps.now() >= deadline) break;
			await this.deps.sleep(this.deps.pollIntervalMs);
		}
		return wardenErrors.err("interrupted", "boot wait stopped");
	}

	/** Every 0.5 s until `signal` aborts: fail once the launched emulator is gone or the deadline passed. */
	private async watchBoot(
		serial: string,
		deadline: number,
		watch: BootWatch,
		signal: AbortSignal,
		timedOut: () => Result<void, WardenError>
	): AsyncResult<void, WardenError> {
		while (!signal.aborted) {
			await this.deps.sleep(LIVENESS_POLL_MS);
			if (signal.aborted) break;
			if (watch.pid !== undefined && !this.deps.pidAlive(watch.pid))
				return wardenErrors.err("failed", emulatorLog.exited(serial, watch.pid, watch.logPath));
			if (this.deps.now() >= deadline) return timedOut();
		}
		return wardenErrors.err("interrupted", "boot wait stopped");
	}
}

/** Takes console-port leases for new emulators. */
export class ConsolePortLeaser {
	constructor(private readonly deps: Pick<ProviderDeps, "store" | "owner" | "now">) {}

	/**
	 * Take a console-port lease (`emulator <name>`) under the store's cross-process lock: the first even
	 * port whose console and adb ports are neither leased nor used by a running emulator.
	 */
	lease(name: string, running: AdbEmulator[]): Result<{ lease: Lease; port: number }, WardenError> {
		const { deps } = this;
		return deps.store.transaction(() => {
			const taken = new Set<number>();
			for (const lease of deps.store.listLeases()) {
				if (lease.resource.kind === "port") taken.add(lease.resource.port);
			}
			for (const emu of running) {
				taken.add(emu.port);
				taken.add(emu.port + 1);
			}
			const port = adbParser.pickConsolePort(taken);
			if (port === undefined) {
				return wardenErrors.err(
					"capacity_exhausted",
					`no free emulator console port in ${CONSOLE_PORT_MIN}-${CONSOLE_PORT_MAX}`
				);
			}
			const lease = deps.store.insertLease(
				{ resource: { kind: "port", port }, owner: deps.owner, ttlMs: DEFAULT_TTL_MS, label: `emulator ${name}` },
				deps.now()
			);
			return resultFactory.ok({ lease, port });
		});
	}
}

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
	 * one exists: a claim never builds one. `resultFactory.ok(undefined)` = none (off, not built yet, no SDK). A failure
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

/** Bound on each of the system-ready waits around the unlock of a biometrics emulator. */
const SYSTEM_READY_MS = 60_000;
const SETTLED_READY_MS = 15_000;

/** An emulator this provider launched: the boot wait watches its pid. */
type Launch = { pid: number; logPath: string; logOffset: number; avd: string; snapshot?: string };

/** A launched emulator process and the log it writes. */
type Launched = { pid: number; logPath: string; logOffset: number };

/**
 * Android emulators on `adb` + `emulator`. Warden never boots an existing emulator — it launches a
 * new headless `-read-only` instance of an AVD (so one AVD backs many emulators) on a leased even
 * console port, and only kills emulators it launched (store `devices` table).
 */
export class AndroidProvider extends BaseDeviceProvider {
	readonly platform = "android" as const;

	private readonly tools: AndroidTools;
	private readonly adb: Adb;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly pollIntervalMs: number;
	private readonly pidAlive: PidAlive;
	private readonly spawnDetached: SpawnDetached;
	/** emulators this provider launched: the boot wait watches their pid */
	private readonly launches = new Map<string, Launch>();
	/** the last inventory's `adb devices`, reused by a `create` right after it */
	private lastListing: { at: number; emulators: AdbEmulator[] } | undefined;

	constructor(
		deps: ProviderDeps,
		private readonly options: AndroidProviderOptions = {}
	) {
		super(deps);
		this.tools = androidToolsLocator.locate(deps.env);
		this.adb = new Adb(deps);
		this.sleep = options.sleep ?? sleeper.sleep;
		this.pollIntervalMs = options.pollIntervalMs ?? 250;
		this.pidAlive = options.pidAlive ?? liveness.processAlive;
		this.spawnDetached = options.spawnDetached ?? new DetachedSpawner(options.earlyExitMs).spawn;
	}

	async inventory(): AsyncResult<InventoryDevice[], WardenError> {
		const listed = await this.adb.listDevices();
		if (!listed.success) return listed;
		const emulators: AdbEmulator[] = listed.data.flatMap((e) =>
			e.kind === "emulator" ? [{ serial: e.serial, port: e.port, state: e.state }] : []
		);
		const others = listed.data.flatMap((e) => (e.kind === "other" ? [e] : []));
		this.lastListing = { at: this.deps.now(), emulators };
		const recorded = new Map(this.deps.store.listDevices("android").map((r) => [r.id, r.name]));
		const goldenPorts = this.goldenPorts();
		const known = emulators.filter((e) => e.state === "device" || e.state === "offline");
		const [described, phones] = await Promise.all([
			Promise.all(known.map((e) => this.describeEmulator(e, recorded.get(e.serial), goldenPorts.has(e.port)))),
			Promise.all(others.map((entry) => this.describeOther(entry))),
		]);
		return resultFactory.ok([...described, ...phones]);
	}

	async create(name: string, profile: string, runtime?: string): AsyncResult<InventoryDevice, WardenError> {
		const resolved = await this.resolveLaunchTarget(profile);
		if (!resolved.success) return resolved;
		const { avdName, target, snapshot } = resolved.data;
		const running = await this.runningEmulators();
		if (!running.success) return running;

		const leased = new ConsolePortLeaser(this.deps).lease(name, running.data);
		if (!leased.success) return leased;
		const { lease, port } = leased.data;
		const serial = `emulator-${port}`;
		const launched = await this.launchOrColdBoot(avdName, port, serial, snapshot);
		if (!launched.success) {
			this.deps.store.deleteLeases([lease.id]);
			return launched;
		}
		this.launches.set(serial, { ...launched.data, avd: target });

		const recordedRuntime = runtime !== undefined && runtime !== "latest" ? runtime : undefined;
		this.remember({ id: serial, name, profile, runtime: recordedRuntime });
		const device: InventoryDevice = {
			platform: "android",
			id: serial,
			name,
			state: "booting",
			wardenCreated: true,
			profile,
		};
		if (recordedRuntime !== undefined) device.runtime = recordedRuntime;
		return resultFactory.ok(device);
	}

	async waitReady(id: string, timeoutMs: number): AsyncResult<void, WardenError> {
		const waiter = new BootWaiter({
			...this.deps,
			sleep: this.sleep,
			pidAlive: this.pidAlive,
			pollIntervalMs: this.pollIntervalMs,
		});
		if (!adbParser.isEmulatorSerial(id)) {
			// a phone: only wait for the OS; BOOT_SETTINGS (package verifier) are persistent and never touch one
			return waiter.wait(id, timeoutMs);
		}
		const launched = this.launches.get(id);
		const booted = await waiter.wait(id, timeoutMs, launched);
		if (booted.success) await this.adb.run(this.adbCmd(id, "shell", emulatorArgv.bootSettingsCommand()));
		const ready = booted.success ? await this.settleBiometricsDevice(id, launched?.avd) : booted;
		if (!ready.success) await this.discardUnready(id);
		else await this.noteSnapshotOutcome(id, launched);
		return ready;
	}

	async verifyWarm(id: string): AsyncResult<void, WardenError> {
		if (adbParser.isEmulatorSerial(id)) return wardenErrors.err("unsupported", "no warm check for emulators");
		const prop = await this.adb.run(this.adbCmd(id, "shell", "getprop", "sys.boot_completed"), {
			timeoutMs: PROP_READ_TIMEOUT_MS,
		});
		if (!prop.success) return prop;
		return prop.data.trim() === "1"
			? resultFactory.ok(undefined)
			: wardenErrors.err("failed", `${id} has not finished booting`);
	}

	protected isPhysical(id: string): boolean {
		return !adbParser.isEmulatorSerial(id);
	}

	protected async refuse(verb: RefusedVerb, id: string): AsyncResult<void, WardenError> {
		if (verb === "shut down") {
			return wardenErrors.err("device_foreign", `refusing to shut down ${id}: a physical device is never shut down`);
		}
		const listed = await this.adb.listDevices();
		const state = listed.success ? listed.data.find((e) => e.serial === id)?.state : undefined;
		if (state === "unauthorized")
			return wardenErrors.err(
				"device_foreign",
				`${id} is unauthorized: accept the USB debugging prompt on the phone, then retry`
			);
		return wardenErrors.err(
			"device_foreign",
			`${id} is a physical device: warden never boots one (state: ${state ?? "not connected"})`
		);
	}

	protected async bootDevice(id: string): AsyncResult<void, WardenError> {
		// A warden emulator `create` just launched may not have reached the adb server yet: poll for it.
		const launched = this.recordOf(id) !== undefined;
		const polls = launched ? Math.ceil(REGISTER_TIMEOUT_MS / REGISTER_POLL_MS) : 0;
		for (let i = 0; ; i++) {
			const emulators = await this.adb.listEmulators();
			if (!emulators.success) return emulators;
			if (emulators.data.some((e) => e.serial === id)) return resultFactory.ok(undefined);
			if (i >= polls) break;
			await this.sleep(REGISTER_POLL_MS);
		}
		return launched
			? wardenErrors.err(
					"timeout",
					`${id} did not register with adb within ${REGISTER_TIMEOUT_MS / 1000}s of its launch`
				)
			: wardenErrors.err("device_unknown", `${id} is not running — android devices are created, not booted`);
	}

	protected async shutdownDevice(id: string): AsyncResult<void, WardenError> {
		if (this.recordOf(id) === undefined) {
			return wardenErrors.err("device_foreign", `refusing to shut down foreign emulator ${id}`);
		}
		const killed = await this.adb.run(this.adbCmd(id, "emu", "kill"), { timeoutMs: EMU_CONSOLE_TIMEOUT_MS });
		if (!killed.success) {
			const emulators = await this.adb.listEmulators();
			if (!emulators.success || emulators.data.some((e) => e.serial === id)) return killed;
		}
		const port = adbParser.serialPort(id);
		this.deps.store.transaction(() => {
			if (port !== undefined) {
				const lease = this.deps.store.findLeaseByResource({ kind: "port", port });
				if (this.isEmulatorPortLease(lease)) this.deps.store.deleteLeases([lease.id]);
			}
			this.deps.store.forgetDevice("android", id);
		});
		return resultFactory.ok(undefined);
	}

	private adbCmd(serial: string, ...args: string[]): readonly string[] {
		return [this.tools.adb, "-s", serial, ...args];
	}

	private goldenPorts(): Set<number> {
		return new Set(
			this.deps.store
				.listLeases()
				.flatMap((l) => (l.resource.kind === "port" && l.label?.startsWith(GOLDEN_PORT_LABEL) ? [l.resource.port] : []))
		);
	}

	private isEmulatorPortLease(lease: Lease | undefined): lease is Lease {
		return lease?.resource.kind === "port" && (lease.label?.startsWith("emulator ") ?? false);
	}

	/**
	 * A biometrics emulator (by its launch, or by its recorded profile when warden reuses one) must be past its PIN
	 * lock screen and have adb + the package manager answering before anything installs.
	 */
	private async settleBiometricsDevice(id: string, avd: string | undefined): AsyncResult<void, WardenError> {
		const recorded = this.recordOf(id);
		if (recorded === undefined || !biometricProfiles.split(avd ?? recorded.profile ?? "").biometrics)
			return resultFactory.ok(undefined);
		const keyguard = new AndroidKeyguard({
			exec: this.deps.exec,
			sleep: this.sleep,
			adb: this.tools.adb,
			now: this.deps.now,
		});
		const up = wardenErrors.coded(await keyguard.systemReady(id, SYSTEM_READY_MS), "failed");
		if (!up.success) return up;
		const unlocked = wardenErrors.coded(await keyguard.ensureUnlocked(id), "failed");
		if (!unlocked.success) return unlocked;
		// the unlock and the snapshot restore can leave adb flapping offline; an install right after would fail
		return wardenErrors.coded(await keyguard.systemReady(id, SETTLED_READY_MS), "failed");
	}

	/**
	 * A non-console adb row: a phone (`physical`), or a foreign network emulator (qemu props, never physical).
	 * Never an `emu` call. A phone that is not in adb state `device` cannot answer `getprop`, so it is not asked.
	 */
	private async describeOther(entry: Extract<AdbListEntry, { kind: "other" }>): Promise<InventoryDevice> {
		const ready = entry.state === "device";
		const classified = ready ? await this.adb.classifyOther(entry.serial) : undefined;
		const info = classified?.success ? classified.data : undefined;
		const model = info?.model ?? entry.model?.replaceAll("_", " ");
		const device: InventoryDevice = {
			platform: "android",
			id: entry.serial,
			name: model ?? entry.serial,
			state: ready ? "booted" : "booting",
			wardenCreated: false,
		};
		if (info?.sdk !== undefined) device.runtime = `android-${info.sdk}`;
		if (info?.emulator) return device;
		if (model !== undefined) device.profile = leaseModel.profileSlug(model);
		const hwSerial = info?.hwSerial;
		device.physical = {
			platform: "android",
			transport: entry.transport,
			adbState: entry.state,
			...(hwSerial !== undefined ? { hwSerial } : {}),
			...(model !== undefined ? { model } : {}),
		};
		return device;
	}

	/** `emu avd name`, bounded; `hung` = the console did not answer in time. */
	private async avdNameOf(serial: string): Promise<{ name?: string; hung: boolean }> {
		const started = this.deps.now();
		const avd = await this.adb.run(this.adbCmd(serial, "emu", "avd", "name"), { timeoutMs: EMU_CONSOLE_TIMEOUT_MS });
		if (avd.success) return { name: avd.data.split("\n")[0]?.trim(), hung: false };
		return { hung: this.deps.now() - started >= EMU_CONSOLE_TIMEOUT_MS };
	}

	private async describeEmulator(
		emu: AdbEmulator,
		recordedName: string | undefined,
		golden: boolean
	): Promise<InventoryDevice> {
		const online = emu.state === "device";
		const [avd, sdk] = await Promise.all([
			this.avdNameOf(emu.serial),
			online
				? this.adb.run(this.adbCmd(emu.serial, "shell", "getprop", "ro.build.version.sdk"))
				: Promise.resolve(wardenErrors.err("failed", "offline")),
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
		if (avdName) device.profile = leaseModel.profileSlug(avdName);
		const level = sdk.success ? sdk.data.trim() : "";
		if (/^\d+$/.test(level)) device.runtime = `android-${level}`;
		return device;
	}

	/** The AVD whose `profileSlug` is `profile` (the per-process list, re-read once on a miss). */
	private async resolveAvd(profile: string): AsyncResult<string, WardenError> {
		let avds = await this.adb.listAvds();
		if (avds.success && !avds.data.some((a) => leaseModel.profileSlug(a) === profile))
			avds = await this.adb.listAvds({ fresh: true });
		if (!avds.success) return avds;
		const avd = avds.data.find((a) => leaseModel.profileSlug(a) === profile);
		if (avd !== undefined) return resultFactory.ok(avd);
		const available = avds.data.map((a) => `${leaseModel.profileSlug(a)} (${a})`).join(", ") || "none";
		return wardenErrors.err("not_found", `no AVD matches profile "${profile}"; available: ${available}`);
	}

	/** Warden's snapshot of `avd`, if any; a failure to make one is logged, not fatal. */
	private async snapshotFor(avd: string): Promise<string | undefined> {
		if (this.options.snapshot === undefined) return undefined;
		const snapshot = await this.options.snapshot(avd);
		if (snapshot.success) return snapshot.data;
		this.note(`no quick-boot snapshot for ${avd} (${snapshot.error}) — cold boot`);
		return undefined;
	}

	/** A device that never got ready (locked, adb offline) must not be left up for the next claim to reuse; foreign ones are left alone. */
	private async discardUnready(id: string): Promise<void> {
		if (this.recordOf(id) !== undefined) await this.shutdownDevice(id);
	}

	/** Whether a snapshot launch loaded or fell back to a cold boot, reported to the snapshot bookkeeping. */
	private async noteSnapshotOutcome(id: string, launched: Launch | undefined): Promise<void> {
		const snapshot = launched?.snapshot;
		if (!launched || !snapshot) return;
		if (!emulatorLog.snapshotLoadFailed(emulatorLog.read(launched.logPath, launched.logOffset))) {
			this.options.snapshotLoaded?.(launched.avd, snapshot);
			return;
		}
		this.note(`${id}: snapshot ${snapshot} did not load, the emulator cold-booted (log: ${launched.logPath})`);
		const dropped = await this.options.snapshotFailed?.(launched.avd, snapshot);
		if (dropped && !dropped.success) this.note(`${id}: snapshot ${snapshot} kept: ${dropped.error}`);
	}

	/** The AVD, snapshot target and snapshot a `profile` launches from. */
	private async resolveLaunchTarget(
		profile: string
	): AsyncResult<{ avdName: string; target: string; snapshot: string | undefined }, WardenError> {
		const split = biometricProfiles.split(profile);
		const resolved = await this.resolveAvd(split.profile);
		if (!resolved.success) return resolved;
		// a biometrics profile is a separate golden of the AVD; its devices must start enrolled, so no cold-boot fallback
		const target = biometricProfiles.profile(resolved.data, split.biometrics);
		const snapshot = await this.snapshotFor(target);
		if (split.biometrics && snapshot === undefined)
			return wardenErrors.err("failed", this.missingEnrolledSnapshot(profile));
		return resultFactory.ok({ avdName: resolved.data, target, snapshot });
	}

	private missingEnrolledSnapshot(profile: string): string {
		return `profile ${profile} needs its enrolled snapshot, but none is available (android snapshots off, no SDK root, or the build failed); build it with: warden golden ensure --platform android --profile ${profile}`;
	}

	/** Launch a headless, read-only emulator of `avd` on `port`, logging to `$WARDEN_HOME/logs/<serial>.log`. */
	private async launch(
		avd: string,
		port: number,
		serial: string,
		snapshot: string | undefined,
		headless: boolean
	): AsyncResult<Launched, WardenError> {
		const logDir = join(storeLocator.wardenHome(this.deps.env), "logs");
		try {
			mkdirSync(logDir, { recursive: true });
		} catch (error) {
			return wardenErrors.err("failed", error instanceof Error ? error.message : String(error));
		}
		const logPath = join(logDir, `${serial}.log`);
		const logOffset = emulatorLog.size(logPath);
		const argv = emulatorArgv.claim(this.tools, this.deps.env, avd, port, snapshot, headless);
		const spawned = await this.spawnDetached(argv, logPath);
		return spawned.success
			? resultFactory.ok({ pid: spawned.data.pid, logPath, logOffset })
			: wardenErrors.err("failed", spawned.error);
	}

	/** `adb devices` for a create: the last inventory's when it is recent (the claim's own), else a fresh one. */
	private async runningEmulators(): AsyncResult<AdbEmulator[], WardenError> {
		if (this.lastListing !== undefined && this.deps.now() - this.lastListing.at <= LISTING_REUSE_MS)
			return resultFactory.ok(this.lastListing.emulators);
		return this.adb.listEmulators();
	}

	/**
	 * Launch from `snapshot`; if that launch fails, once more with today's cold-boot argv. An emulator that
	 * rejects the headless flags (too old for `-no-metrics`) is relaunched once without them.
	 */
	private async launchOrColdBoot(
		avd: string,
		port: number,
		serial: string,
		snapshot: string | undefined
	): AsyncResult<Launched & { snapshot?: string }, WardenError> {
		let headless = true;
		const attempt = async (from: string | undefined) => {
			const first = await this.launch(avd, port, serial, from, headless);
			if (first.success || !headless || !emulatorArgv.rejectedOption(first.error.message)) return first;
			headless = false;
			this.note(
				`${serial}: the emulator rejected ${emulatorArgv.headlessFlags(this.deps.env).join(" ")} — relaunching without them`
			);
			return this.launch(avd, port, serial, from, false);
		};
		const launched = await attempt(snapshot);
		if (launched.success) return snapshot !== undefined ? resultFactory.ok({ ...launched.data, snapshot }) : launched;
		if (snapshot === undefined) return launched;
		this.note(
			`${serial}: launch from snapshot ${snapshot} failed (${launched.error.message}) — retrying with a cold boot`
		);
		return attempt(undefined);
	}
}
