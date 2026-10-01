import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { profileSlug } from "../allocate";
import { DEFAULT_TTL_MS } from "../config.defaults";
import { type ExecOptions, execError } from "../exec";
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

/** Run a command; exec throwing (e.g. binary not found) becomes a failed result. */
async function run(deps: ExecDeps, cmd: readonly string[], opts?: ExecOptions): AsyncResult<string> {
	try {
		const result = await deps.exec(cmd, opts);
		return result.exitCode === 0 ? ok(result.stdout) : err(execError(cmd, result));
	} catch (error) {
		return err(`\`${cmd.join(" ")}\` failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** AVD names from `emulator -list-avds`. */
export async function listAvds(deps: ExecDeps): AsyncResult<string[]> {
	const { emulator } = androidTools(deps.env);
	const result = await run(deps, [emulator, "-list-avds"]);
	return result.success ? ok(parseAvdList(result.data)) : result;
}

async function listEmulators(deps: ExecDeps): AsyncResult<AdbEmulator[]> {
	const { adb } = androidTools(deps.env);
	const result = await run(deps, [adb, "devices", "-l"]);
	return result.success ? ok(parseAdbDevices(result.data)) : result;
}

/** Launch `cmd` so it outlives warden, stdout/stderr appended to `logPath`. */
export type SpawnDetached = (cmd: readonly string[], logPath: string) => AsyncResult<{ pid: number }>;

export type AndroidProviderOptions = {
	spawnDetached?: SpawnDetached;
	sleep?: (ms: number) => Promise<void>;
	/** `sys.boot_completed` poll interval, default 2 s */
	pollIntervalMs?: number;
	/** how long the default `spawnDetached` watches for an immediate exit, default 1.5 s */
	earlyExitMs?: number;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function logTail(logPath: string): string {
	try {
		return readFileSync(logPath, "utf8").trim().split("\n").slice(-3).join(" | ");
	} catch {
		return "";
	}
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

function serialPort(serial: string): number | undefined {
	const match = /^emulator-(\d+)$/.exec(serial);
	return match?.[1] ? Number(match[1]) : undefined;
}

function isEmulatorPortLease(lease: Lease | undefined): lease is Lease {
	return lease?.resource.kind === "port" && (lease.label?.startsWith("emulator ") ?? false);
}

/**
 * Android emulators on `adb` + `emulator`. Warden never boots an existing emulator — it launches a
 * new headless `-read-only` instance of an AVD (so one AVD backs many emulators) on a leased even
 * console port, and only kills emulators it launched (store `devices` table).
 */
export function createAndroidProvider(deps: ProviderDeps, options: AndroidProviderOptions = {}): DeviceProvider {
	const tools = androidTools(deps.env);
	const sleep = options.sleep ?? defaultSleep;
	const pollIntervalMs = options.pollIntervalMs ?? 2_000;
	const spawnDetached = options.spawnDetached ?? createSpawnDetached(options.earlyExitMs);

	const adb = (serial: string, ...args: string[]): readonly string[] => [tools.adb, "-s", serial, ...args];

	async function describeEmulator(emu: AdbEmulator, recordedName: string | undefined): Promise<InventoryDevice> {
		const booted = emu.state === "device";
		const [avd, sdk] = await Promise.all([
			run(deps, adb(emu.serial, "emu", "avd", "name")),
			booted ? run(deps, adb(emu.serial, "shell", "getprop", "ro.build.version.sdk")) : Promise.resolve(err("offline")),
		]);
		const avdName = avd.success ? avd.data.split("\n")[0]?.trim() : undefined;
		const device: InventoryDevice = {
			platform: "android",
			id: emu.serial,
			name: recordedName ?? (avdName || emu.serial),
			state: booted ? "booted" : "booting",
			wardenCreated: false,
		};
		if (avdName) device.profile = profileSlug(avdName);
		const level = sdk.success ? sdk.data.trim() : "";
		if (/^\d+$/.test(level)) device.runtime = `android-${level}`;
		return device;
	}

	/** Take a console-port lease under the store's cross-process lock. */
	function leaseConsolePort(name: string, running: AdbEmulator[]): Result<{ lease: Lease; port: number }> {
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

	/** The AVD whose `profileSlug` is `profile`. */
	async function resolveAvd(profile: string): AsyncResult<string> {
		const avds = await listAvds(deps);
		if (!avds.success) return avds;
		const avd = avds.data.find((a) => profileSlug(a) === profile);
		if (avd !== undefined) return ok(avd);
		const available = avds.data.map((a) => `${profileSlug(a)} (${a})`).join(", ") || "none";
		return err(`no AVD matches profile "${profile}"; available: ${available}`);
	}

	/** Launch a headless, read-only emulator of `avd` on `port`, logging to `$WARDEN_HOME/logs/<serial>.log`. */
	async function launch(avd: string, port: number, serial: string): AsyncResult<{ pid: number }> {
		const logDir = join(wardenHome(deps.env), "logs");
		try {
			mkdirSync(logDir, { recursive: true });
		} catch (error) {
			return err(error);
		}
		const cmd = [
			tools.emulator,
			"-avd",
			avd,
			"-port",
			String(port),
			"-no-window",
			"-read-only",
			"-no-snapshot-save",
			"-no-boot-anim",
		];
		return spawnDetached(cmd, join(logDir, `${serial}.log`));
	}

	return {
		platform: "android",

		async inventory() {
			const emulators = await listEmulators(deps);
			if (!emulators.success) return emulators;
			const recorded = new Map(deps.store.listDevices("android").map((r) => [r.id, r.name]));
			const known = emulators.data.filter((e) => e.state === "device" || e.state === "offline");
			return ok(await Promise.all(known.map((e) => describeEmulator(e, recorded.get(e.serial)))));
		},

		async create(name, profile, runtime) {
			const avd = await resolveAvd(profile);
			if (!avd.success) return avd;
			const running = await listEmulators(deps);
			if (!running.success) return running;

			const leased = leaseConsolePort(name, running.data);
			if (!leased.success) return leased;
			const { lease, port } = leased.data;
			const serial = `emulator-${port}`;
			const launched = await launch(avd.data, port, serial);
			if (!launched.success) {
				deps.store.deleteLeases([lease.id]);
				return launched;
			}

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
			const emulators = await listEmulators(deps);
			if (!emulators.success) return emulators;
			if (emulators.data.some((e) => e.serial === id)) return ok(undefined);
			return err(`${id} is not running — android devices are created, not booted`);
		},

		async waitReady(id, timeoutMs) {
			const start = deps.now();
			const waited = await run(deps, adb(id, "wait-for-device"), { timeoutMs });
			if (!waited.success) return waited;
			while (true) {
				const prop = await run(deps, adb(id, "shell", "getprop", "sys.boot_completed"));
				if (prop.success && prop.data.trim() === "1") return ok(undefined);
				if (deps.now() - start >= timeoutMs) {
					return err(`timed out after ${timeoutMs}ms waiting for ${id} to finish booting`);
				}
				await sleep(pollIntervalMs);
			}
		},

		async shutdown(id) {
			if (!deps.store.listDevices("android").some((d) => d.id === id)) {
				return err(`refusing to shut down foreign emulator ${id}`);
			}
			const killed = await run(deps, adb(id, "emu", "kill"));
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
		},
	};
}
