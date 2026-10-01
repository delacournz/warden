import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { profileSlug } from "../allocate";
import { type Exec, execError } from "../exec";
import { isGoldenName } from "../golden/golden";
import type { DeviceState, InventoryDevice } from "../types";
import type { DeviceProvider, ProviderDeps } from "./provider.types";

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
	lastBootedAt?: string;
	dataPathSize?: number;
};

function isRawSim(value: unknown): value is RawSim {
	return (
		isObject(value) &&
		typeof value.udid === "string" &&
		typeof value.name === "string" &&
		typeof value.state === "string" &&
		(value.isAvailable === undefined || typeof value.isAvailable === "boolean") &&
		(value.deviceTypeIdentifier === undefined || typeof value.deviceTypeIdentifier === "string") &&
		(value.lastBootedAt === undefined || typeof value.lastBootedAt === "string") &&
		(value.dataPathSize === undefined || typeof value.dataPathSize === "number")
	);
}

const STATES: Record<string, DeviceState> = { Booted: "booted", Shutdown: "shutdown", Booting: "booting" };

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-5` → `iOS-26-5`. */
export function shortRuntime(identifier: string): string {
	return identifier.startsWith(RUNTIME_PREFIX) ? identifier.slice(RUNTIME_PREFIX.length) : identifier;
}

/**
 * Flatten `xcrun simctl list devices available -j` into iOS inventory. Non-iOS runtimes (watchOS,
 * tvOS, visionOS) and unavailable sims are dropped; states other than booted/shutdown/booting
 * (e.g. `Shutting Down`) are reported as `booting` — busy, not free to boot. `wardenCreated` is
 * always false here; callers mark warden's own with `markWardenDevices`.
 */
export function parseSimctlDevices(stdout: string): Result<InventoryDevice[]> {
	const sims = parseIosSims(stdout);
	if (!sims.success) return sims;
	return ok(
		sims.data.filter(({ sim }) => sim.isAvailable !== false).map(({ sim, runtime }) => toInventoryDevice(sim, runtime))
	);
}

/** An iOS sim with the extra `simctl list devices -j` fields cleanup decisions need. */
export type SimDetail = InventoryDevice & {
	/** false when its runtime is gone (`simctl delete unavailable` territory) */
	available: boolean;
	/** full device type identifier, e.g. `com.apple.CoreSimulator.SimDeviceType.iPhone-17` */
	deviceType?: string;
	/** epoch ms; undefined = never booted (or an Xcode that doesn't report it) */
	lastBootedAt?: number;
	/** size of the sim's data dir */
	dataBytes?: number;
};

/** Like `parseSimctlDevices` but from `simctl list devices -j` (no `available`): keeps unavailable sims and adds detail. */
export function parseSimctlSimDetails(stdout: string): Result<SimDetail[]> {
	const sims = parseIosSims(stdout);
	if (!sims.success) return sims;
	return ok(
		sims.data.map(({ sim, runtime }): SimDetail => {
			const detail: SimDetail = { ...toInventoryDevice(sim, runtime), available: sim.isAvailable !== false };
			if (sim.deviceTypeIdentifier !== undefined) detail.deviceType = sim.deviceTypeIdentifier;
			if (sim.dataPathSize !== undefined) detail.dataBytes = sim.dataPathSize;
			const booted = sim.lastBootedAt !== undefined ? Date.parse(sim.lastBootedAt) : Number.NaN;
			if (!Number.isNaN(booted)) detail.lastBootedAt = booted;
			return detail;
		})
	);
}

/** Every iOS sim, unavailable ones included, with cleanup detail. */
export async function listSimDetails(exec: Exec): AsyncResult<SimDetail[]> {
	const out = await simctl(exec, ["list", "devices", "-j"]);
	return out.success ? parseSimctlSimDetails(out.data) : out;
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

async function simctl(exec: Exec, args: string[], timeoutMs?: number): AsyncResult<string> {
	const cmd = ["xcrun", "simctl", ...args];
	const result = await exec(cmd, timeoutMs !== undefined ? { timeoutMs } : undefined);
	return result.exitCode === 0 ? ok(result.stdout) : err(execError(cmd, result));
}

/** simctl reports "Unable to <verb> device in current state: <State>" when already there. */
async function idempotent(exec: Exec, args: string[], alreadyState: string): AsyncResult<void> {
	const cmd = ["xcrun", "simctl", ...args];
	const result = await exec(cmd);
	if (result.exitCode === 0) return ok(undefined);
	if (`${result.stderr}\n${result.stdout}`.includes(`current state: ${alreadyState}`)) return ok(undefined);
	return err(execError(cmd, result));
}

/**
 * Shut down (if booted) and permanently `simctl delete` a sim. Callers decide whether warden may
 * touch it. `shutdown: false` for an unavailable sim — its runtime is gone, so it can't be running.
 */
export async function deleteSim(exec: Exec, udid: string, opts: { shutdown?: boolean } = {}): AsyncResult<void> {
	if (opts.shutdown !== false) {
		const down = await idempotent(exec, ["shutdown", udid], "Shutdown");
		if (!down.success) return down;
	}
	const deleted = await simctl(exec, ["delete", udid]);
	return deleted.success ? ok(undefined) : deleted;
}

/** `simctl list devicetypes/runtimes` → the device type + runtime `simctl create` should use for this profile. */
export async function lookupCreateTarget(
	exec: Exec,
	profile: string,
	runtime: string | undefined
): AsyncResult<{ type: SimDeviceType; runtime: SimRuntime }> {
	const typesOut = await simctl(exec, ["list", "devicetypes", "-j"]);
	if (!typesOut.success) return typesOut;
	const types = parseSimctlDeviceTypes(typesOut.data);
	if (!types.success) return types;
	const runtimesOut = await simctl(exec, ["list", "runtimes", "-j"]);
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
};

/** iOS simulators on `xcrun simctl` (default CoreSimulator set). Boots headless — never opens Simulator.app. */
export function createIosProvider(deps: ProviderDeps, options: IosProviderOptions = {}): DeviceProvider {
	const { exec } = deps;
	const record = (id: string, name: string, profile: string, runtime: string): InventoryDevice => {
		deps.store.recordDevice({ platform: "ios", id, name, profile, runtime }, deps.now());
		return { platform: "ios", id, name, state: "shutdown", wardenCreated: true, profile, runtime };
	};
	return {
		platform: "ios",

		async inventory() {
			const out = await simctl(exec, ["list", "devices", "available", "-j"]);
			return out.success ? parseSimctlDevices(out.data) : out;
		},

		async create(name, profile, runtime) {
			if (options.clone) {
				const cloned = await options.clone(name, profile, runtime);
				if (cloned.success) return ok(record(cloned.data.udid, name, profile, cloned.data.runtime));
				deps.log?.(`clone failed (${cloned.error}) — creating ${name} fresh (slow first boot)`);
			}
			const target = await lookupCreateTarget(exec, profile, runtime);
			if (!target.success) return target;
			const created = await simctl(exec, ["create", name, target.data.type.identifier, target.data.runtime.identifier]);
			if (!created.success) return created;
			const id = created.data.trim();
			if (!id) return err(`simctl create ${name}: no udid returned`);
			return ok(record(id, name, profile, shortRuntime(target.data.runtime.identifier)));
		},

		boot: (id) => idempotent(exec, ["boot", id], "Booted"),

		async waitReady(id, timeoutMs) {
			const out = await simctl(exec, ["bootstatus", id, "-b"], timeoutMs);
			return out.success ? ok(undefined) : err(`${id} not ready within ${Math.round(timeoutMs / 1000)}s: ${out.error}`);
		},

		shutdown: (id) => idempotent(exec, ["shutdown", id], "Shutdown"),
	};
}
