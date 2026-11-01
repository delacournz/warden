import { DEFAULT_SLIM_PROFILE, type SlimProfile, slimProfiles } from "@delacour/warden-config/slim.profile";
import { type Exec, type ExecResult, execErrors } from "@delacour/warden-runtime/exec";
import { type DeviceState, type InventoryDevice, leaseModel } from "@delacour/warden-store/types";
import { type WardenError, wardenErrors } from "@delacour/warden-types/error";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { biometricProfiles } from "./biometrics";
import { BaseDeviceProvider, type RefusedVerb } from "./device-provider";
import { Devicectl } from "./devicectl";
import { disabledStoreRoot } from "./disabled-store";
import { goldenNames } from "./golden-name";
import { BoundedExec, IosHealth, type TimedExec, type Timer, timers } from "./health";
import type { BootReady, ProviderDeps } from "./provider.types";
import { SimSlimmer } from "./slim";
import { OfflineSlimVerifier, offlineSlimPrep } from "./slim.offline";

const RUNTIME_PREFIX = "com.apple.CoreSimulator.SimRuntime.";
const DEVICE_TYPE_PREFIX = "com.apple.CoreSimulator.SimDeviceType.";

type JsonObject = Record<string, unknown>;

type RawSim = {
	udid: string;
	name: string;
	state: string;
	isAvailable?: boolean;
	deviceTypeIdentifier?: string;
};

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

export type SimRuntime = {
	identifier: string;
	name: string;
	version: string;
	/** runtime build, e.g. `23F5043` (`buildversion`) */
	build?: string;
	/** device type identifiers this runtime supports; undefined when simctl didn't say */
	supportedDeviceTypes?: string[];
};

export type SimDeviceType = { identifier: string; name: string };

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

/** Reads the JSON documents of `xcrun simctl list … -j`. */
export class SimctlParser {
	/** `com.apple.CoreSimulator.SimRuntime.iOS-26-5` → `iOS-26-5`. */
	shortRuntime(identifier: string): string {
		return identifier.startsWith(RUNTIME_PREFIX) ? identifier.slice(RUNTIME_PREFIX.length) : identifier;
	}

	/**
	 * Flatten `xcrun simctl list devices available -j` into iOS inventory. Non-iOS runtimes (watchOS,
	 * tvOS, visionOS) and unavailable sims are dropped; `Shutting Down` is reported as `shutdown`, any
	 * other state as `booting` — busy, not free to boot. `wardenCreated` is
	 * always false here; callers mark warden's own with `markWardenDevices`.
	 */
	parseDevices(stdout: string): Result<InventoryDevice[], WardenError> {
		const sims = this.parseIosSims(stdout);
		if (!sims.success) return sims;
		return resultFactory.ok(
			sims.data
				.filter(({ sim }) => sim.isAvailable !== false)
				.map(({ sim, runtime }) => this.toInventoryDevice(sim, runtime))
		);
	}

	/** Available iOS runtimes from `xcrun simctl list runtimes -j`, newest first. */
	parseRuntimes(stdout: string): Result<SimRuntime[], WardenError> {
		const parsed = this.parseJson(stdout, "simctl list runtimes");
		if (!parsed.success) return parsed;
		const { runtimes } = parsed.data;
		if (!Array.isArray(runtimes)) return wardenErrors.err("failed", "simctl list runtimes: missing `runtimes`");
		const out = runtimes.map((r) => this.toSimRuntime(r)).filter((r): r is SimRuntime => r !== undefined);
		return resultFactory.ok(out.sort((a, b) => this.compareVersionDesc(a.version, b.version)));
	}

	/** Device types from `xcrun simctl list devicetypes -j`. */
	parseDeviceTypes(stdout: string): Result<SimDeviceType[], WardenError> {
		const parsed = this.parseJson(stdout, "simctl list devicetypes");
		if (!parsed.success) return parsed;
		const { devicetypes } = parsed.data;
		if (!Array.isArray(devicetypes))
			return wardenErrors.err("failed", "simctl list devicetypes: missing `devicetypes`");
		return resultFactory.ok(
			devicetypes.flatMap((t) =>
				this.isObject(t) && typeof t.identifier === "string" && typeof t.name === "string"
					? [{ identifier: t.identifier, name: t.name }]
					: []
			)
		);
	}

	/** Pick the device type for a profile slug, and the newest matching runtime that supports it. */
	resolveCreateTarget(
		types: SimDeviceType[],
		runtimes: SimRuntime[],
		profile: string,
		runtime: string | undefined
	): Result<{ type: SimDeviceType; runtime: SimRuntime }, WardenError> {
		const type = types.find((t) => leaseModel.profileSlug(t.name) === profile);
		if (!type) {
			const known = types.map((t) => leaseModel.profileSlug(t.name)).join(", ");
			return wardenErrors.err("not_found", `no iOS device type for profile "${profile}" (known: ${known})`);
		}
		const candidates = runtimes.filter((r) => this.runtimeMatches(r, runtime));
		if (candidates.length === 0) {
			const known = runtimes.map((r) => this.shortRuntime(r.identifier)).join(", ");
			return wardenErrors.err(
				"not_found",
				`no available iOS runtime matching "${runtime}" (available: ${known || "none"})`
			);
		}
		const supported = candidates.find(
			(r) => r.supportedDeviceTypes === undefined || r.supportedDeviceTypes.includes(type.identifier)
		);
		if (!supported) {
			return wardenErrors.err("not_found", `no iOS runtime matching "${runtime ?? "latest"}" supports ${type.name}`);
		}
		return resultFactory.ok({ type, runtime: supported });
	}

	private isObject(value: unknown): value is JsonObject {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	private parseJson(stdout: string, what: string): Result<JsonObject, WardenError> {
		try {
			const value: unknown = JSON.parse(stdout);
			return this.isObject(value)
				? resultFactory.ok(value)
				: wardenErrors.err("failed", `${what}: expected a JSON object`);
		} catch (error) {
			return wardenErrors.err(
				"failed",
				`${what}: invalid JSON (${error instanceof Error ? error.message : String(error)})`
			);
		}
	}

	private isRawSim(value: unknown): value is RawSim {
		return (
			this.isObject(value) &&
			typeof value.udid === "string" &&
			typeof value.name === "string" &&
			typeof value.state === "string" &&
			(value.isAvailable === undefined || typeof value.isAvailable === "boolean") &&
			(value.deviceTypeIdentifier === undefined || typeof value.deviceTypeIdentifier === "string")
		);
	}

	private parseIosSims(stdout: string): Result<Array<{ sim: RawSim; runtime: string }>, WardenError> {
		const parsed = this.parseJson(stdout, "simctl list devices");
		if (!parsed.success) return parsed;
		const { devices } = parsed.data;
		if (!this.isObject(devices)) return wardenErrors.err("failed", "simctl list devices: missing `devices`");
		const out: Array<{ sim: RawSim; runtime: string }> = [];
		for (const [runtimeKey, list] of Object.entries(devices)) {
			const runtime = this.shortRuntime(runtimeKey);
			if (!runtime.startsWith("iOS-")) continue;
			const sims = this.parseRuntimeSims(runtimeKey, list);
			if (!sims.success) return sims;
			out.push(...sims.data.map((sim) => ({ sim, runtime })));
		}
		return resultFactory.ok(out);
	}

	private parseRuntimeSims(runtimeKey: string, list: unknown): Result<RawSim[], WardenError> {
		if (!Array.isArray(list)) return wardenErrors.err("failed", `simctl list devices: \`${runtimeKey}\` is not a list`);
		if (!list.every((entry) => this.isRawSim(entry)))
			return wardenErrors.err("failed", `simctl list devices: unexpected device entry under \`${runtimeKey}\``);
		return resultFactory.ok(list);
	}

	private toInventoryDevice(sim: RawSim, runtime: string): InventoryDevice {
		const device: InventoryDevice = {
			platform: "ios",
			id: sim.udid,
			name: sim.name,
			state: STATES[sim.state] ?? "booting",
			wardenCreated: false,
			runtime,
		};
		if (goldenNames.isGolden(sim.name)) device.golden = true;
		if (sim.deviceTypeIdentifier?.startsWith(DEVICE_TYPE_PREFIX)) {
			device.profile = leaseModel.profileSlug(sim.deviceTypeIdentifier.slice(DEVICE_TYPE_PREFIX.length));
		}
		return device;
	}

	private versionParts(version: string): number[] {
		return version.split(".").map((p) => Number(p) || 0);
	}

	private compareVersionDesc(a: string, b: string): number {
		const av = this.versionParts(a);
		const bv = this.versionParts(b);
		for (let i = 0; i < Math.max(av.length, bv.length); i++) {
			const diff = (bv[i] ?? 0) - (av[i] ?? 0);
			if (diff !== 0) return diff;
		}
		return 0;
	}

	private isIosRuntime(r: JsonObject, identifier: string): boolean {
		if (typeof r.platform === "string") return r.platform === "iOS";
		return this.shortRuntime(identifier).startsWith("iOS-");
	}

	private toSimRuntime(r: unknown): SimRuntime | undefined {
		if (!this.isObject(r) || typeof r.identifier !== "string" || typeof r.version !== "string") return undefined;
		if (r.isAvailable === false || !this.isIosRuntime(r, r.identifier)) return undefined;
		const runtime: SimRuntime = {
			identifier: r.identifier,
			name: typeof r.name === "string" ? r.name : this.shortRuntime(r.identifier),
			version: r.version,
		};
		if (typeof r.buildversion === "string") runtime.build = r.buildversion;
		if (Array.isArray(r.supportedDeviceTypes)) {
			runtime.supportedDeviceTypes = r.supportedDeviceTypes
				.filter((t): t is JsonObject => this.isObject(t))
				.map((t) => t.identifier)
				.filter((id): id is string => typeof id === "string");
		}
		return runtime;
	}

	/** `latest`/undefined → any; else `iOS-26-5`, full identifier, `26.5`, `iOS 26.5`. */
	private runtimeMatches(runtime: SimRuntime, wanted: string | undefined): boolean {
		if (wanted === undefined || wanted === "latest") return true;
		return (
			runtime.identifier === wanted ||
			this.shortRuntime(runtime.identifier) === wanted ||
			runtime.version === wanted ||
			runtime.version.startsWith(`${wanted}.`) ||
			runtime.name === wanted ||
			runtime.name === `iOS ${wanted}`
		);
	}
}

export const simctlParser = new SimctlParser();

/** `xcrun simctl` through an exec bounded by a timer (real timers by default). */
export class Simctl {
	readonly runner: TimedExec;
	private readonly bounded: BoundedExec;

	constructor(exec: Exec, timer?: (ms: number) => Timer) {
		this.runner = { exec, timer: timer ?? timers.real };
		this.bounded = new BoundedExec(this.runner);
	}

	timedOutError(cmd: readonly string[], timeoutMs: number): string {
		return `\`${cmd.join(" ")}\` did not finish within ${Math.round(timeoutMs / 1000)}s`;
	}

	/** Run `cmd`; with `timeoutMs`, a call still running then is an error (and the process is killed). */
	async runCmd(cmd: string[], timeoutMs?: number): Promise<ExecResult | string> {
		if (timeoutMs === undefined) return this.runner.exec(cmd);
		return (await this.bounded.within(cmd, timeoutMs)) ?? this.timedOutError(cmd, timeoutMs);
	}

	async run(args: string[], timeoutMs?: number): AsyncResult<string, WardenError> {
		const cmd = ["xcrun", "simctl", ...args];
		const result = await this.runCmd(cmd, timeoutMs);
		if (typeof result === "string") return wardenErrors.err("timeout", result, { retryable: true });
		return result.exitCode === 0
			? resultFactory.ok(result.stdout)
			: wardenErrors.err("failed", execErrors.format(cmd, result));
	}

	/** simctl reports "Unable to <verb> device in current state: <State>" when already there. */
	async idempotent(args: string[], alreadyState: string, timeoutMs?: number): AsyncResult<void, WardenError> {
		const cmd = ["xcrun", "simctl", ...args];
		const result = await this.runCmd(cmd, timeoutMs);
		if (typeof result === "string") return wardenErrors.err("timeout", result, { retryable: true });
		if (result.exitCode === 0) return resultFactory.ok(undefined);
		if (`${result.stderr}\n${result.stdout}`.includes(`current state: ${alreadyState}`))
			return resultFactory.ok(undefined);
		return wardenErrors.err("failed", execErrors.format(cmd, result));
	}

	/**
	 * Shut down (if booted) and permanently `simctl delete` a sim. Callers decide whether warden may
	 * touch it. `shutdown: false` for an unavailable sim — its runtime is gone, so it can't be running.
	 */
	async deleteSim(udid: string, opts: { shutdown?: boolean } = {}): AsyncResult<void, WardenError> {
		if (opts.shutdown !== false) {
			const down = await this.idempotent(["shutdown", udid], "Shutdown");
			if (!down.success) return down;
		}
		const deleted = await this.run(["delete", udid]);
		return deleted.success ? resultFactory.ok(undefined) : deleted;
	}

	/**
	 * `simctl list devicetypes/runtimes` (asked at the same time, each bounded by `IOS_TIMEOUTS.listMs`)
	 * → the device type + runtime `simctl create` should use for this profile.
	 */
	async lookupCreateTarget(
		profile: string,
		runtime: string | undefined
	): AsyncResult<{ type: SimDeviceType; runtime: SimRuntime }, WardenError> {
		const [typesOut, runtimesOut] = await Promise.all([
			this.run(["list", "devicetypes", "-j"], IOS_TIMEOUTS.listMs),
			this.run(["list", "runtimes", "-j"], IOS_TIMEOUTS.listMs),
		]);
		if (!typesOut.success) return typesOut;
		const types = simctlParser.parseDeviceTypes(typesOut.data);
		if (!types.success) return types;
		if (!runtimesOut.success) return runtimesOut;
		const runtimes = simctlParser.parseRuntimes(runtimesOut.data);
		if (!runtimes.success) return runtimes;
		return simctlParser.resolveCreateTarget(types.data, runtimes.data, profile, runtime);
	}
}

/** BiometricKit's enrollment notification: state 1 + post enrolls, 0 + post unenrolls. */
const ENROLLMENT_NOTIFICATION = "com.apple.BiometricKit.enrollmentChanged";

/** Bounded retries of the biometrics enroll: a write right after `bootstatus` can be dropped. */
const ENROLL_ATTEMPTS = 10;
const ENROLL_RETRY_MS = 1000;

/** Makes a new sim by cloning a prepared image; returns its udid + short runtime. */
export type IosCloneStrategy = (
	name: string,
	profile: string,
	runtime: string | undefined
) => AsyncResult<{ udid: string; runtime: string }, WardenError>;

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
	/**
	 * List paired physical iPhones/iPads (`devicectl`) in `inventory`. Off by default: it is one more process
	 * per inventory, which a claim of a simulator should not pay. `devices` and physical claims turn it on.
	 */
	physical?: boolean;
	/** phones the caller named: a longer reachability wait than an auto-pick gets */
	namedPhysical?: readonly string[];
};

/** How often, and how long, `boot` retries a sim that is still `Shutting Down`. */
const SHUTTING_DOWN_POLL_MS = 500;
const SHUTTING_DOWN_WAIT_MS = 30_000;

/**
 * iOS simulators on `xcrun simctl` (default CoreSimulator set), plus paired physical iPhones/iPads from
 * `xcrun devicectl` in `inventory` (leasable, probed with `lockState`, never booted or shut down).
 * Boots headless — never opens Simulator.app.
 */
export class IosProvider extends BaseDeviceProvider {
	readonly platform = "ios" as const;

	private readonly simctl: Simctl;
	private readonly health: IosHealth;
	private readonly devicectl: Devicectl;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly slim: SlimProfile | false;

	constructor(
		deps: ProviderDeps,
		private readonly options: IosProviderOptions = {}
	) {
		super(deps);
		this.simctl = new Simctl(deps.exec, deps.timer);
		this.health = new IosHealth(this.simctl.runner);
		this.devicectl = new Devicectl(this.simctl.runner);
		this.sleep = options.sleep ?? Bun.sleep;
		this.slim = options.slim === undefined ? DEFAULT_SLIM_PROFILE : options.slim;
	}

	/**
	 * Best effort, called for a device this claim is about to boot from shutdown (after a create, or a
	 * shutdown reuse), never for an already-booted one. A failure is logged by the provider, never fatal.
	 */
	async prepareBoot(id: string): Promise<void> {
		if (leaseModel.isPhysicalIosId(id)) return;
		const slim = this.slim;
		const target = slim === false ? undefined : this.slimTarget(id);
		if (slim === false || !target) return;
		const runtime = await this.runtimeOf(id, target.runtime);
		if (runtime === undefined || !offlineSlimPrep.supportsPersistentOverrides(runtime)) return;
		const prepared = await offlineSlimPrep.prepare(id, slim, { root: disabledStoreRoot.resolve(this.deps.env) });
		if (!prepared.success) this.note(`${target.name} offline slim skipped (${prepared.error})`);
	}

	/** Called once the device is ready, before the health probe. Best effort. */
	async afterReady(id: string): Promise<void> {
		if (leaseModel.isPhysicalIosId(id)) return;
		await this.enrollBiometrics(id);
		const slim = this.slim;
		if (slim === false) return;
		const target = this.slimTarget(id);
		if (!target) return;
		if (await this.verifySlim(id, slim, target.name)) this.deps.store.setSlimmed("ios", id, this.deps.now());
	}

	async inventory(): AsyncResult<InventoryDevice[], WardenError> {
		// phones are best effort: no Xcode, a wedged CoreDevice or a bad document leaves the simulator list as it was
		const [out, phones] = await Promise.all([
			this.simctl.run(["list", "devices", "available", "-j"], IOS_TIMEOUTS.listMs),
			this.options.physical === true
				? this.devicectl.listPhysical({ named: this.options.namedPhysical ?? [] })
				: Promise.resolve(resultFactory.ok<InventoryDevice[]>([])),
		]);
		if (!out.success) return out;
		const sims = simctlParser.parseDevices(out.data);
		return sims.success && phones.success ? resultFactory.ok([...sims.data, ...phones.data]) : sims;
	}

	async create(name: string, profile: string, runtime?: string): AsyncResult<InventoryDevice, WardenError> {
		// `<profile>+bio` is the same device type; only the pool identity (and the enrollment after boot) differs
		const typeProfile = biometricProfiles.split(profile).profile;
		if (this.options.clone) {
			const cloned = await this.options.clone(name, typeProfile, runtime);
			if (cloned.success) {
				return resultFactory.ok(
					await this.recordCreated(this.record(cloned.data.udid, name, profile, cloned.data.runtime))
				);
			}
			this.note(`clone failed (${cloned.error.message}) — creating ${name} fresh (slow first boot)`);
		}
		const target = await this.simctl.lookupCreateTarget(typeProfile, runtime);
		if (!target.success) return target;
		const created = await this.simctl.run(
			["create", name, target.data.type.identifier, target.data.runtime.identifier],
			IOS_TIMEOUTS.createMs
		);
		if (!created.success) return created;
		const id = created.data.trim();
		if (!id) return wardenErrors.err("failed", `simctl create ${name}: no udid returned`);
		return resultFactory.ok(this.record(id, name, profile, simctlParser.shortRuntime(target.data.runtime.identifier)));
	}

	waitReady(id: string, timeoutMs: number): AsyncResult<void, WardenError> {
		return leaseModel.isPhysicalIosId(id) ? this.probePhone(id) : this.bootstatus(id, timeoutMs);
	}

	/**
	 * `bootstatus -b` boots a shut-down sim itself, so a separate `simctl boot` is one CoreSimulator
	 * round trip too many (16-15). When bootstatus answers with an error (not a timeout) — e.g. a sim
	 * still `Shutting Down` — fall back to `boot` (which waits that out) and wait again, with only what
	 * is left of `timeoutMs`, so the whole call stays within one ready budget.
	 */
	async bootReady(id: string, timeoutMs: number): Promise<BootReady> {
		if (leaseModel.isPhysicalIosId(id)) return { kind: "boot-failed", error: this.physicalRefusal("boot", id) };
		const started = this.deps.now();
		const status = await this.simctl.runCmd(["xcrun", "simctl", "bootstatus", id, "-b"], timeoutMs);
		if (typeof status !== "string" && status.exitCode === 0) return { kind: "ready" };
		if (typeof status === "string") {
			return { kind: "not-ready", error: this.notReadyError(id, timeoutMs, status) };
		}
		const booted = await this.bootAfterShutdown(id);
		if (!booted.success) return { kind: "boot-failed", error: booted.error };
		const left = timeoutMs - (this.deps.now() - started);
		if (left <= 0) {
			return { kind: "not-ready", error: this.notReadyError(id, timeoutMs, "booted, no time left") };
		}
		const ready = await this.bootstatus(id, left);
		return ready.success ? { kind: "ready" } : { kind: "not-ready", error: ready.error };
	}

	/** A phone: `devicectl device info lockState` answers (locked or not). A sim: SpringBoard health. */
	probe(id: string): AsyncResult<void, WardenError> {
		return leaseModel.isPhysicalIosId(id) ? this.probePhone(id) : this.health.probe(id);
	}

	verifyWarm(id: string): AsyncResult<void, WardenError> {
		return leaseModel.isPhysicalIosId(id) ? this.probePhone(id) : this.health.probeWarm(id);
	}

	/** After a `bootstatus` that saw the boot finish, launchd is up: SpringBoard running is all that is left to prove. */
	probeBooted(id: string): AsyncResult<void, WardenError> {
		return leaseModel.isPhysicalIosId(id) ? this.probePhone(id) : this.health.probeWarm(id);
	}

	protected isPhysical(id: string): boolean {
		return leaseModel.isPhysicalIosId(id);
	}

	/** What every boot / shutdown / create-side call says about an iPhone or iPad: warden leases it, nothing more. */
	protected async refuse(verb: RefusedVerb, id: string): AsyncResult<void, WardenError> {
		return { success: false, error: this.physicalRefusal(verb, id) };
	}

	protected bootDevice(id: string): AsyncResult<void, WardenError> {
		return this.bootAfterShutdown(id);
	}

	protected shutdownDevice(id: string): AsyncResult<void, WardenError> {
		return this.simctl.idempotent(["shutdown", id], "Shutdown", IOS_TIMEOUTS.shutdownMs);
	}

	private physicalRefusal(verb: string, id: string): WardenError {
		return {
			code: "device_foreign",
			message: `refusing to ${verb} ${id}: a physical iPhone/iPad is never booted, shut down or created by warden`,
		};
	}

	private notReadyError(id: string, timeoutMs: number, why: string): WardenError {
		return wardenErrors.err("timeout", `${id} not ready within ${Math.round(timeoutMs / 1000)}s: ${why}`, {
			retryable: true,
		}).error;
	}

	/** `simctl boot`, waiting out a shutdown in progress (simctl refuses to boot a `Shutting Down` sim). */
	private async bootAfterShutdown(id: string): AsyncResult<void, WardenError> {
		for (let waited = 0; ; waited += SHUTTING_DOWN_POLL_MS) {
			const booted = await this.simctl.idempotent(["boot", id], "Booted", IOS_TIMEOUTS.bootMs);
			if (booted.success || !booted.error.message.includes("current state: Shutting Down")) return booted;
			if (waited >= SHUTTING_DOWN_WAIT_MS) return booted;
			await this.sleep(SHUTTING_DOWN_POLL_MS);
		}
	}

	private async bootstatus(id: string, timeoutMs: number): AsyncResult<void, WardenError> {
		const out = await this.simctl.run(["bootstatus", id, "-b"], timeoutMs);
		if (out.success) return resultFactory.ok(undefined);
		return wardenErrors.err(
			out.error.code,
			`${id} not ready within ${Math.round(timeoutMs / 1000)}s: ${out.error.message}`,
			{
				retryable: true,
			}
		);
	}

	/** A phone answers `lockState` (locked or not), else its failure as a coded error. */
	private async probePhone(id: string): AsyncResult<void, WardenError> {
		return wardenErrors.coded(await this.devicectl.probe(id), "failed");
	}

	private record(id: string, name: string, profile: string, runtime: string): InventoryDevice {
		this.remember({ id, name, profile, runtime });
		return { platform: "ios", id, name, state: "shutdown", wardenCreated: true, profile, runtime };
	}

	private async recordCreated(device: InventoryDevice): Promise<InventoryDevice> {
		await this.prepareBoot(device.id);
		return device;
	}

	/** Store record of a device this provider may slim: warden's own, never a golden. */
	private slimTarget(id: string): { name: string; runtime: string | undefined } | undefined {
		const rec = this.recordOf(id);
		if (!rec || goldenNames.isGolden(rec.name)) return undefined;
		return { name: rec.name, runtime: rec.runtime };
	}

	/** The device's runtime: its store record, else the live inventory. */
	private async runtimeOf(id: string, recorded: string | undefined): Promise<string | undefined> {
		if (recorded !== undefined) return recorded;
		const inv = await this.simctl.run(["list", "devices", "available", "-j"], IOS_TIMEOUTS.listMs);
		const parsed = inv.success ? simctlParser.parseDevices(inv.data) : inv;
		return parsed.success ? parsed.data.find((d) => d.id === id)?.runtime : undefined;
	}

	/**
	 * Verify the offline slim once the sim is ready, with a live fallback for what did not take.
	 * True when every override is in place (so the store may mark the device slimmed).
	 */
	private async verifySlim(id: string, slim: SlimProfile, name: string): Promise<boolean> {
		const verified = await new OfflineSlimVerifier(this.deps.exec).verify(id, slim, { sleep: this.sleep });
		if (!verified.success) {
			this.note(`${name} slim verify failed (${verified.error})`);
			return false;
		}
		const { missing } = verified.data;
		if (missing.length === 0) return true;
		const total = slimProfiles.desiredLabels(slim).size;
		this.note(`${id} came up with ${total - missing.length}/${total} overrides, fixing live`);
		const fixed = await new SimSlimmer(this.deps.exec).slim(id, { profile: slim });
		if (!fixed.success) this.note(`${name} live slim failed (${fixed.error})`);
		return fixed.success;
	}

	/**
	 * A biometrics sim (recorded profile `<profile>+bio`) enrolls on every boot: the simulator forgets its enrollment
	 * when it shuts down, and a clone of a golden starts unenrolled, so there is nothing to bake. Runs before any
	 * app install, so keys created with biometry-bound access control are not invalidated later.
	 *
	 * `bootstatus -b` returns before the biometric stack is up, and a state written that early can be dropped
	 * (`notifyutil -g` reads 0 right after the write). So every attempt reads the state back and a miss is retried,
	 * a bounded number of times.
	 */
	private async enrollBiometrics(id: string): Promise<void> {
		const rec = this.recordOf(id);
		if (!rec || goldenNames.isGolden(rec.name) || !biometricProfiles.split(rec.profile ?? "").biometrics) return;
		for (let attempt = 1; attempt <= ENROLL_ATTEMPTS; attempt++) {
			if (!(await this.postEnrollment(id, rec.name))) return;
			if (await this.enrollmentTook(id)) return;
			if (attempt < ENROLL_ATTEMPTS) await this.sleep(ENROLL_RETRY_MS);
		}
		this.note(`${rec.name} biometrics enroll did not take after ${ENROLL_ATTEMPTS} attempts`);
	}

	/** Set the enrollment state and post the notification; false (and a note) when simctl fails. */
	private async postEnrollment(id: string, name: string): Promise<boolean> {
		for (const args of [
			["-s", ENROLLMENT_NOTIFICATION, "1"],
			["-p", ENROLLMENT_NOTIFICATION],
		]) {
			const out = await this.simctl.run(["spawn", id, "notifyutil", ...args], IOS_TIMEOUTS.listMs);
			if (!out.success) {
				this.note(`${name} biometrics enroll failed (${out.error})`);
				return false;
			}
		}
		return true;
	}

	private async enrollmentTook(id: string): Promise<boolean> {
		const read = await this.simctl.run(["spawn", id, "notifyutil", "-g", ENROLLMENT_NOTIFICATION], IOS_TIMEOUTS.listMs);
		return read.success && /\s1\s*$/.test(read.data);
	}
}
