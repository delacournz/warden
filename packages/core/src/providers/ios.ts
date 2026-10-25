import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { profileSlug } from "../allocate";
import { type Exec, type ExecResult, execError } from "../exec";
import { isGoldenName } from "../golden/golden";
import { disabledStoreRoot } from "../sims/disabled-store";
import { slimSimulator } from "../sims/slim";
import { prepareOfflineSlim, runtimeSupportsPersistentOverrides, verifyOfflineSlim } from "../sims/slim.offline";
import { DEFAULT_SLIM_PROFILE, desiredLabels, type SlimProfile } from "../sims/slim.profile";
import type { DeviceState, InventoryDevice } from "../types";
import { execWithin, probeIosHealth, probeIosWarm, realTimer, type TimedExec, type Timer } from "./health";
import type { BootReady, DeviceProvider, ProviderDeps } from "./provider.types";

const RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";
const DEVICE_TYPE_PREFIX = "com.apple.CoreSimulator.SimDeviceType.";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(stdout: string, what: string): Result<JsonObject> {
	try {
		const value: unknown = JSON.parse(stdout);
		return isObject(value) ? ok(value) : err(`${what}: expected a JSON object`);
	} catch (error) {
		return err(`${what}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
}

type RawSim = {
	udid: string;
	name: string;
	state: string;
	isAvailable?: boolean;
	deviceTypeIdentifier?: string;
};

function isRawSim(value: unknown): value is RawSim {
	return (
		isObject(value) &&
		typeof value.udid === "string" &&
		typeof value.name === "string" &&
		typeof value.state === "string" &&
		(value.isAvailable === undefined || typeof value.isAvailable === "boolean") &&
		(value.deviceTypeIdentifier === undefined || typeof value.deviceTypeIdentifier === "string")
	);
}

/**
 * `Shutting Down` counts as `shutdown`: the device is on its way down (e.g. gc shutting it while a
 * claim reads the list), so a claim must boot it (`boot` waits out the shutdown), never reuse it.
 */
const STATES: Record<string, DeviceState> = {
	Booted: "booted",
	Shutdown: "shutdown",
	Booting: "booting",
	"Shutting Down": "shutdown",
};

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-5` → `iOS-26-5`. */
export function shortRuntime(identifier: string): string {
	return identifier.startsWith(RUNTIME_PREFIX) ? identifier.slice(RUNTIME_PREFIX.length) : identifier;
}

/**
 * Flatten `xcrun simctl list devices available -j` into iOS inventory. Non-iOS runtimes (watchOS,
 * tvOS, visionOS) and unavailable sims are dropped; `Shutting Down` is reported as `shutdown`, any
 * other state as `booting` — busy, not free to boot. `wardenCreated` is
 * always false here; callers mark warden's own with `markWardenDevices`.
 */
export function parseSimctlDevices(stdout: string): Result<InventoryDevice[]> {
	const sims = parseIosSims(stdout);
	if (!sims.success) return sims;
	return ok(
		sims.data.filter(({ sim }) => sim.isAvailable !== false).map(({ sim, runtime }) => toInventoryDevice(sim, runtime))
	);
}

function parseIosSims(stdout: string): Result<Array<{ sim: RawSim; runtime: string }>> {
	const parsed = parseJson(stdout, "simctl list devices");
	if (!parsed.success) return parsed;
	const { devices } = parsed.data;
	if (!isObject(devices)) return err("simctl list devices: missing `devices`");
	const out: Array<{ sim: RawSim; runtime: string }> = [];
	for (const [runtimeKey, list] of Object.entries(devices)) {
		const runtime = shortRuntime(runtimeKey);
		if (!runtime.startsWith("iOS-")) continue;
		const sims = parseRuntimeSims(runtimeKey, list);
		if (!sims.success) return sims;
		out.push(...sims.data.map((sim) => ({ sim, runtime })));
	}
	return ok(out);
}

function parseRuntimeSims(runtimeKey: string, list: unknown): Result<RawSim[]> {
	if (!Array.isArray(list)) return err(`simctl list devices: \`${runtimeKey}\` is not a list`);
	if (!list.every(isRawSim)) return err(`simctl list devices: unexpected device entry under \`${runtimeKey}\``);
	return ok(list);
}

function toInventoryDevice(sim: RawSim, runtime: string): InventoryDevice {
	const device: InventoryDevice = {
		platform: "ios",
		id: sim.udid,
		name: sim.name,
		state: STATES[sim.state] ?? "booting",
		wardenCreated: false,
		runtime,
	};
	if (isGoldenName(sim.name)) device.golden = true;
	if (sim.deviceTypeIdentifier?.startsWith(DEVICE_TYPE_PREFIX)) {
		device.profile = profileSlug(sim.deviceTypeIdentifier.slice(DEVICE_TYPE_PREFIX.length));
	}
	return device;
}

export type SimRuntime = {
	identifier: string;
	name: string;
	version: string;
	/** runtime build, e.g. `23F5043` (`buildversion`) */
	build?: string;
	/** device type identifiers this runtime supports; undefined when simctl didn't say */
	supportedDeviceTypes?: string[];
};

function versionParts(version: string): number[] {
	return version.split(".").map((p) => Number(p) || 0);
}

function compareVersionDesc(a: string, b: string): number {
	const av = versionParts(a);
	const bv = versionParts(b);
	for (let i = 0; i < Math.max(av.length, bv.length); i++) {
		const diff = (bv[i] ?? 0) - (av[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function isIosRuntime(r: JsonObject, identifier: string): boolean {
	if (typeof r.platform === "string") return r.platform === "iOS";
	return shortRuntime(identifier).startsWith("iOS-");
}

function toSimRuntime(r: unknown): SimRuntime | undefined {
	if (!isObject(r) || typeof r.identifier !== "string" || typeof r.version !== "string") return undefined;
	if (r.isAvailable === false || !isIosRuntime(r, r.identifier)) return undefined;
	const runtime: SimRuntime = {
		identifier: r.identifier,
		name: typeof r.name === "string" ? r.name : shortRuntime(r.identifier),
		version: r.version,
	};
	if (typeof r.buildversion === "string") runtime.build = r.buildversion;
	if (Array.isArray(r.supportedDeviceTypes)) {
		runtime.supportedDeviceTypes = r.supportedDeviceTypes
			.filter(isObject)
			.map((t) => t.identifier)
			.filter((id): id is string => typeof id === "string");
	}
	return runtime;
}

/** Available iOS runtimes from `xcrun simctl list runtimes -j`, newest first. */
export function parseSimctlRuntimes(stdout: string): Result<SimRuntime[]> {
	const parsed = parseJson(stdout, "simctl list runtimes");
	if (!parsed.success) return parsed;
	const { runtimes } = parsed.data;
	if (!Array.isArray(runtimes)) return err("simctl list runtimes: missing `runtimes`");
	const out = runtimes.map(toSimRuntime).filter((r): r is SimRuntime => r !== undefined);
	return ok(out.sort((a, b) => compareVersionDesc(a.version, b.version)));
}

export type SimDeviceType = { identifier: string; name: string };

/** Device types from `xcrun simctl list devicetypes -j`. */
export function parseSimctlDeviceTypes(stdout: string): Result<SimDeviceType[]> {
	const parsed = parseJson(stdout, "simctl list devicetypes");
	if (!parsed.success) return parsed;
	const { devicetypes } = parsed.data;
	if (!Array.isArray(devicetypes)) return err("simctl list devicetypes: missing `devicetypes`");
	return ok(
		devicetypes.flatMap((t) =>
			isObject(t) && typeof t.identifier === "string" && typeof t.name === "string"
				? [{ identifier: t.identifier, name: t.name }]
				: []
		)
	);
}

/** `latest`/undefined → any; else `iOS-26-5`, full identifier, `26.5`, `iOS 26.5`. */
function runtimeMatches(runtime: SimRuntime, wanted: string | undefined): boolean {
	if (wanted === undefined || wanted === "latest") return true;
	return (
		runtime.identifier === wanted ||
		shortRuntime(runtime.identifier) === wanted ||
		runtime.version === wanted ||
		runtime.version.startsWith(`${wanted}.`) ||
		runtime.name === wanted ||
		runtime.name === `iOS ${wanted}`
	);
}

/** Pick the device type for a profile slug, and the newest matching runtime that supports it. */
export function resolveCreateTarget(
	types: SimDeviceType[],
	runtimes: SimRuntime[],
	profile: string,
	runtime: string | undefined
): Result<{ type: SimDeviceType; runtime: SimRuntime }> {
	const type = types.find((t) => profileSlug(t.name) === profile);
	if (!type) {
		const known = types.map((t) => profileSlug(t.name)).join(", ");
		return err(`no iOS device type for profile "${profile}" (known: ${known})`);
	}
	const candidates = runtimes.filter((r) => runtimeMatches(r, runtime));
	if (candidates.length === 0) {
		const known = runtimes.map((r) => shortRuntime(r.identifier)).join(", ");
		return err(`no available iOS runtime matching "${runtime}" (available: ${known || "none"})`);
	}
	const supported = candidates.find(
		(r) => r.supportedDeviceTypes === undefined || r.supportedDeviceTypes.includes(type.identifier)
	);
	if (!supported) {
		return err(`no iOS runtime matching "${runtime ?? "latest"}" supports ${type.name}`);
	}
	return ok({ type, runtime: supported });
}

/**
 * Default timeouts for simctl calls that CoreSimulator can wedge (16-11): far above normal times, so
 * they only end a hang — a claim, or a clone holding the golden lock, never waits forever.
 */
export const IOS_TIMEOUTS = {
	listMs: 30_000,
	createMs: 120_000,
	cloneMs: 120_000,
	bootMs: 120_000,
	shutdownMs: 60_000,
} as const;

/** `exec` bounded by `timer` (real timers by default). */
export function timedExec(exec: Exec, timer?: (ms: number) => Timer): TimedExec {
	return { exec, timer: timer ?? realTimer };
}

export function timedOutError(cmd: readonly string[], timeoutMs: number): string {
	return `\`${cmd.join(" ")}\` did not finish within ${Math.round(timeoutMs / 1000)}s`;
}

/** Run `cmd`; with `timeoutMs`, a call still running then is an error (and the process is killed). */
async function runCmd(runner: TimedExec, cmd: string[], timeoutMs?: number): Promise<ExecResult | string> {
	if (timeoutMs === undefined) return runner.exec(cmd);
	return (await execWithin(runner, cmd, timeoutMs)) ?? timedOutError(cmd, timeoutMs);
}

async function simctl(runner: TimedExec, args: string[], timeoutMs?: number): AsyncResult<string> {
	const cmd = ["xcrun", "simctl", ...args];
	const result = await runCmd(runner, cmd, timeoutMs);
	if (typeof result === "string") return err(result);
	return result.exitCode === 0 ? ok(result.stdout) : err(execError(cmd, result));
}

/** simctl reports "Unable to <verb> device in current state: <State>" when already there. */
async function idempotent(
	runner: TimedExec,
	args: string[],
	alreadyState: string,
	timeoutMs?: number
): AsyncResult<void> {
	const cmd = ["xcrun", "simctl", ...args];
	const result = await runCmd(runner, cmd, timeoutMs);
	if (typeof result === "string") return err(result);
	if (result.exitCode === 0) return ok(undefined);
	if (`${result.stderr}\n${result.stdout}`.includes(`current state: ${alreadyState}`)) return ok(undefined);
	return err(execError(cmd, result));
}

/**
 * Shut down (if booted) and permanently `simctl delete` a sim. Callers decide whether warden may
 * touch it. `shutdown: false` for an unavailable sim — its runtime is gone, so it can't be running.
 */
export async function deleteSim(exec: Exec, udid: string, opts: { shutdown?: boolean } = {}): AsyncResult<void> {
	const runner = timedExec(exec);
	if (opts.shutdown !== false) {
		const down = await idempotent(runner, ["shutdown", udid], "Shutdown");
		if (!down.success) return down;
	}
	const deleted = await simctl(runner, ["delete", udid]);
	return deleted.success ? ok(undefined) : deleted;
}

/**
 * `simctl list devicetypes/runtimes` (asked at the same time, each bounded by `IOS_TIMEOUTS.listMs`)
 * → the device type + runtime `simctl create` should use for this profile.
 */
export async function lookupCreateTarget(
	exec: Exec,
	profile: string,
	runtime: string | undefined,
	timer?: (ms: number) => Timer
): AsyncResult<{ type: SimDeviceType; runtime: SimRuntime }> {
	const runner = timedExec(exec, timer);
	const [typesOut, runtimesOut] = await Promise.all([
		simctl(runner, ["list", "devicetypes", "-j"], IOS_TIMEOUTS.listMs),
		simctl(runner, ["list", "runtimes", "-j"], IOS_TIMEOUTS.listMs),
	]);
	if (!typesOut.success) return typesOut;
	const types = parseSimctlDeviceTypes(typesOut.data);
	if (!types.success) return types;
	if (!runtimesOut.success) return runtimesOut;
	const runtimes = parseSimctlRuntimes(runtimesOut.data);
	if (!runtimes.success) return runtimes;
	return resolveCreateTarget(types.data, runtimes.data, profile, runtime);
}

/** Makes a new sim by cloning a prepared image; returns its udid + short runtime. */
export type IosCloneStrategy = (
	name: string,
	profile: string,
	runtime: string | undefined
) => AsyncResult<{ udid: string; runtime: string }>;

export type IosProviderOptions = {
	/** when set, `create` clones (e.g. from a golden) and falls back to `simctl create` on failure */
	clone?: IosCloneStrategy;
	/** waits between `boot` attempts on a sim still `Shutting Down` (default: real timers) */
	sleep?: (ms: number) => Promise<void>;
	/**
	 * Daemon slimming for sims this provider boots: the profile (default `DEFAULT_SLIM_PROFILE`), or
	 * `false` for none. Written offline before first boot when the runtime honours it (iOS >= 18.5),
	 * verified once the sim is ready, with a live fallback for what did not take.
	 */
	slim?: SlimProfile | false;
};

/** How often, and how long, `boot` retries a sim that is still `Shutting Down`. */
const SHUTTING_DOWN_POLL_MS = 500;
const SHUTTING_DOWN_WAIT_MS = 30_000;

/** `simctl boot`, waiting out a shutdown in progress (simctl refuses to boot a `Shutting Down` sim). */
async function bootAfterShutdown(
	runner: TimedExec,
	id: string,
	sleep: (ms: number) => Promise<void>
): AsyncResult<void> {
	for (let waited = 0; ; waited += SHUTTING_DOWN_POLL_MS) {
		const booted = await idempotent(runner, ["boot", id], "Booted", IOS_TIMEOUTS.bootMs);
		if (booted.success || !booted.error.includes("current state: Shutting Down")) return booted;
		if (waited >= SHUTTING_DOWN_WAIT_MS) return booted;
		await sleep(SHUTTING_DOWN_POLL_MS);
	}
}

/** iOS simulators on `xcrun simctl` (default CoreSimulator set). Boots headless — never opens Simulator.app. */
export function createIosProvider(deps: ProviderDeps, options: IosProviderOptions = {}): DeviceProvider {
	const { exec } = deps;
	const runner = timedExec(exec, deps.timer);
	const sleep = options.sleep ?? Bun.sleep;
	const waitReady = async (id: string, timeoutMs: number): AsyncResult<void> => {
		const out = await simctl(runner, ["bootstatus", id, "-b"], timeoutMs);
		return out.success ? ok(undefined) : err(`${id} not ready within ${Math.round(timeoutMs / 1000)}s: ${out.error}`);
	};
	const record = (id: string, name: string, profile: string, runtime: string): InventoryDevice => {
		deps.store.recordDevice({ platform: "ios", id, name, profile, runtime }, deps.now());
		return { platform: "ios", id, name, state: "shutdown", wardenCreated: true, profile, runtime };
	};
	const slim = options.slim === undefined ? DEFAULT_SLIM_PROFILE : options.slim;
	const note = (line: string): void => deps.log?.(line);
	/** Store record of a device this provider may slim: warden's own, never a golden. */
	const slimTarget = (id: string): { name: string; runtime: string | undefined } | undefined => {
		const rec = deps.store.listDevices("ios").find((d) => d.id === id);
		if (!rec || isGoldenName(rec.name)) return undefined;
		return { name: rec.name, runtime: rec.runtime };
	};
	/** The device's runtime: its store record, else the live inventory. */
	const runtimeOf = async (id: string, recorded: string | undefined): Promise<string | undefined> => {
		if (recorded !== undefined) return recorded;
		const inv = await simctl(runner, ["list", "devices", "available", "-j"], IOS_TIMEOUTS.listMs);
		const parsed = inv.success ? parseSimctlDevices(inv.data) : inv;
		return parsed.success ? parsed.data.find((d) => d.id === id)?.runtime : undefined;
	};
	const prepareBoot = async (id: string): Promise<void> => {
		const target = slim === false ? undefined : slimTarget(id);
		if (slim === false || !target) return;
		const runtime = await runtimeOf(id, target.runtime);
		if (runtime === undefined || !runtimeSupportsPersistentOverrides(runtime)) return;
		const prepared = await prepareOfflineSlim(id, slim, { root: disabledStoreRoot(deps.env) });
		if (!prepared.success) note(`${target.name} offline slim skipped (${prepared.error})`);
	};
	const afterReady = async (id: string): Promise<void> => {
		if (slim === false) return;
		const target = slimTarget(id);
		if (!target) return;
		const verified = await verifyOfflineSlim(exec, id, slim, { sleep });
		if (!verified.success) {
			note(`${target.name} slim verify failed (${verified.error})`);
			return;
		}
		const { missing } = verified.data;
		if (missing.length > 0) {
			const total = desiredLabels(slim).size;
			note(`${id} came up with ${total - missing.length}/${total} overrides, fixing live`);
			const fixed = await slimSimulator(exec, id, { profile: slim });
			if (!fixed.success) {
				note(`${target.name} live slim failed (${fixed.error})`);
				return;
			}
		}
		deps.store.setSlimmed("ios", id, deps.now());
	};
	const recordCreated = async (device: InventoryDevice): Promise<InventoryDevice> => {
		await prepareBoot(device.id);
		return device;
	};
	return {
		platform: "ios",

		prepareBoot,

		afterReady,

		async inventory() {
			const out = await simctl(runner, ["list", "devices", "available", "-j"], IOS_TIMEOUTS.listMs);
			return out.success ? parseSimctlDevices(out.data) : out;
		},

		async create(name, profile, runtime) {
			if (options.clone) {
				const cloned = await options.clone(name, profile, runtime);
				if (cloned.success) {
					return ok(await recordCreated(record(cloned.data.udid, name, profile, cloned.data.runtime)));
				}
				deps.log?.(`clone failed (${cloned.error}) — creating ${name} fresh (slow first boot)`);
			}
			const target = await lookupCreateTarget(exec, profile, runtime, deps.timer);
			if (!target.success) return target;
			const created = await simctl(
				runner,
				["create", name, target.data.type.identifier, target.data.runtime.identifier],
				IOS_TIMEOUTS.createMs
			);
			if (!created.success) return created;
			const id = created.data.trim();
			if (!id) return err(`simctl create ${name}: no udid returned`);
			return ok(record(id, name, profile, shortRuntime(target.data.runtime.identifier)));
		},

		boot: (id) => bootAfterShutdown(runner, id, sleep),

		waitReady,

		/**
		 * `bootstatus -b` boots a shut-down sim itself, so a separate `simctl boot` is one CoreSimulator
		 * round trip too many (16-15). When bootstatus answers with an error (not a timeout) — e.g. a sim
		 * still `Shutting Down` — fall back to `boot` (which waits that out) and wait again, with only what
		 * is left of `timeoutMs`, so the whole call stays within one ready budget.
		 */
		async bootReady(id, timeoutMs): Promise<BootReady> {
			const started = deps.now();
			const cmd = ["xcrun", "simctl", "bootstatus", id, "-b"];
			const status = await runCmd(runner, cmd, timeoutMs);
			if (typeof status !== "string" && status.exitCode === 0) return { kind: "ready" };
			if (typeof status === "string") {
				return { kind: "not-ready", error: `${id} not ready within ${Math.round(timeoutMs / 1000)}s: ${status}` };
			}
			const booted = await bootAfterShutdown(runner, id, sleep);
			if (!booted.success) return { kind: "boot-failed", error: booted.error };
			const left = timeoutMs - (deps.now() - started);
			if (left <= 0) {
				return {
					kind: "not-ready",
					error: `${id} not ready within ${Math.round(timeoutMs / 1000)}s: booted, no time left`,
				};
			}
			const ready = await waitReady(id, left);
			return ready.success ? { kind: "ready" } : { kind: "not-ready", error: ready.error };
		},

		shutdown: (id) => idempotent(runner, ["shutdown", id], "Shutdown", IOS_TIMEOUTS.shutdownMs),

		probe: (id) => probeIosHealth(runner, id),

		verifyWarm: (id) => probeIosWarm(runner, id),

		/** After a `bootstatus` that saw the boot finish, launchd is up: SpringBoard running is all that is left to prove. */
		probeBooted: (id) => probeIosWarm(runner, id),
	};
}
