import { execErrors } from "@delacour/warden-runtime/exec";
import type { InventoryDevice, PhysicalInfo } from "@delacour/warden-store/types";
import { type AsyncResult, type Result, resultFactory } from "@delacour/warden-types/result";
import { BoundedExec, type TimedExec } from "./health";

/**
 * Real iPhones and iPads through `xcrun devicectl`: listing for inventory and a reachability probe. devicectl
 * prints JSON to stdout with `--json-output -` (progress goes to stderr, silenced by `--quiet`). Nothing here
 * boots, installs or changes a device.
 */

/** Far above normal times (~0.1 s list): only ends a hang, so a sim claim never waits on a wedged CoreDevice. */
export const DEVICECTL_TIMEOUTS = { listMs: 15_000, probeMs: 15_000 } as const;

/** How long a phone that is not connected right now gets to answer `lockState` before it counts as offline (devicectl's `--timeout` floor is 5 s). */
export const REACHABLE_PROBE_MS = 5_000;

/** The wait for a phone the caller named (`--udid`, `physical.ids`, `WARDEN_UDID`): an idle phone may need that long to bring its CoreDevice tunnel up. */
export const NAMED_PROBE_MS = 20_000;

/** The devicectl command lines warden runs. */
export class DevicectlArgv {
	listDevices(): string[] {
		return [
			"xcrun",
			"devicectl",
			"list",
			"devices",
			"--json-output",
			"-",
			"--quiet",
			"--timeout",
			String(DEVICECTL_TIMEOUTS.listMs / 1000 - 5),
		];
	}

	lockState(udid: string, timeoutMs?: number): string[] {
		return [
			"xcrun",
			"devicectl",
			"device",
			"info",
			"lockState",
			"--device",
			udid,
			"--json-output",
			"-",
			"--quiet",
			"--timeout",
			String(
				timeoutMs === undefined ? DEVICECTL_TIMEOUTS.probeMs / 1000 - 5 : Math.max(5, Math.ceil(timeoutMs / 1000))
			),
		];
	}
}

export const devicectlArgv = new DevicectlArgv();

type JsonObject = Record<string, unknown>;

/** Typed reads of devicectl's JSON documents. */
export class DevicectlJson {
	isObject(value: unknown): value is JsonObject {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}

	obj(parent: JsonObject | undefined, key: string): JsonObject | undefined {
		const value = parent?.[key];
		return this.isObject(value) ? value : undefined;
	}

	str(parent: JsonObject | undefined, key: string): string | undefined {
		const value = parent?.[key];
		return typeof value === "string" && value !== "" ? value : undefined;
	}

	parse(stdout: string, what: string): Result<JsonObject> {
		try {
			const value: unknown = JSON.parse(stdout);
			return this.isObject(value) ? resultFactory.ok(value) : resultFactory.err(`${what}: expected a JSON object`);
		} catch (error) {
			return resultFactory.err(`${what}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
		}
	}

	/** `result.passcodeRequired` of a `lockState` document: true while the phone is locked. */
	passcodeRequired(document: JsonObject): unknown {
		return this.obj(document, "result")?.passcodeRequired;
	}
}

const devicectlJson = new DevicectlJson();

/** Reads `devicectl list devices` into physical iOS inventory. */
export class DevicectlParser {
	/**
	 * Flatten `devicectl list devices` JSON into physical iOS inventory. Simulators (`reality: simulated`), watches
	 * and TVs are dropped. A device is `booted` (ready) when paired with Developer Mode on; otherwise `shutdown`,
	 * with `developerMode` / `pairingState` in its `PhysicalInfo` saying why.
	 */
	parseDevices(stdout: string): Result<InventoryDevice[]> {
		const parsed = devicectlJson.parse(stdout, "devicectl list devices");
		if (!parsed.success) return parsed;
		const result = devicectlJson.obj(parsed.data, "result");
		const devices = result?.devices;
		if (!Array.isArray(devices)) return resultFactory.err("devicectl list devices: missing `result.devices`");
		return resultFactory.ok(devices.flatMap((entry) => this.toDevice(entry) ?? []));
	}

	/** `developerModeStatus`: the string `enabled` (deprecated block) or `{ enabled: {…} }` (`properties.state`). */
	private developerModeOn(...statuses: unknown[]): boolean {
		return statuses.some((s) => s === "enabled" || (devicectlJson.isObject(s) && "enabled" in s));
	}

	private physicalInfo(entry: JsonObject): PhysicalInfo {
		const props = devicectlJson.obj(entry, "properties");
		// devicectl is moving to `properties`; the deprecated blocks are still what carries `ddiServicesAvailable`
		const hardware = devicectlJson.obj(entry, "hardwareProperties") ?? devicectlJson.obj(props, "hardware");
		const device = devicectlJson.obj(entry, "deviceProperties");
		const connection = devicectlJson.obj(entry, "connectionProperties") ?? devicectlJson.obj(props, "connection");
		const software = devicectlJson.obj(devicectlJson.obj(props, "software"), "osVersionNumber");
		const tunnelIp =
			devicectlJson.str(connection, "tunnelIPAddress") ?? devicectlJson.str(connection, "tunnelIPAddressString");
		const pairingState = devicectlJson.str(connection, "pairingState") ?? "unknown";
		const tunnelState = devicectlJson.str(connection, "tunnelState");
		return {
			platform: "ios",
			transport: devicectlJson.str(connection, "transportType") === "wired" ? "wired" : "localNetwork",
			deviceType: devicectlJson.str(hardware, "deviceType") ?? "unknown",
			osVersion:
				devicectlJson.str(device, "osVersionNumber") ?? devicectlJson.str(software, "stringValue") ?? "unknown",
			developerMode: this.developerModeOn(
				device?.developerModeStatus,
				devicectlJson.obj(props, "state")?.developerModeStatus
			),
			ddi: device?.ddiServicesAvailable === true,
			...(tunnelIp === undefined ? {} : { tunnelIp }),
			...(tunnelState === undefined ? {} : { tunnelState }),
			...(pairingState === "paired" ? {} : { pairingState }),
		};
	}

	private toDevice(entry: unknown): InventoryDevice | undefined {
		if (!devicectlJson.isObject(entry)) return undefined;
		const props = devicectlJson.obj(entry, "properties");
		const hardware = devicectlJson.obj(entry, "hardwareProperties") ?? devicectlJson.obj(props, "hardware");
		const platform = devicectlJson.str(hardware, "platform");
		if (devicectlJson.str(hardware, "reality") !== "physical" || (platform !== "iOS" && platform !== "iPadOS"))
			return undefined;
		const udid = devicectlJson.str(hardware, "udid");
		if (udid === undefined) return undefined;
		const physical = this.physicalInfo(entry);
		const ready = physical.platform === "ios" && physical.pairingState === undefined && physical.developerMode;
		return {
			platform: "ios",
			id: udid,
			name:
				devicectlJson.str(devicectlJson.obj(entry, "deviceProperties"), "name") ??
				devicectlJson.str(devicectlJson.obj(props, "state"), "name") ??
				udid,
			state: ready ? "booted" : "shutdown",
			wardenCreated: false,
			physical,
		};
	}
}

export const devicectlParser = new DevicectlParser();

/** Physical iPhones/iPads through `xcrun devicectl`, every call bounded by the runner's timer. */
export class Devicectl {
	private readonly bounded: BoundedExec;

	constructor(runner: TimedExec) {
		this.bounded = new BoundedExec(runner);
	}

	/** Physical iPhones/iPads CoreDevice knows about. An error (no Xcode, devicectl wedged) is the caller's to ignore. */
	async listPhysical(opts: { named?: readonly string[] } = {}): AsyncResult<InventoryDevice[]> {
		const out = await this.run(devicectlArgv.listDevices(), DEVICECTL_TIMEOUTS.listMs);
		if (!out.success) return out;
		const parsed = devicectlParser.parseDevices(out.data);
		return parsed.success
			? resultFactory.ok(
					await Promise.all(
						parsed.data.map((d) =>
							this.markReachability(d, opts.named?.includes(d.id) ? NAMED_PROBE_MS : REACHABLE_PROBE_MS)
						)
					)
				)
			: parsed;
	}

	/** `devicectl device info lockState`: is a passcode needed to use the phone now. */
	async readLockState(udid: string): AsyncResult<{ locked: boolean }> {
		const out = await this.run(devicectlArgv.lockState(udid), DEVICECTL_TIMEOUTS.probeMs);
		if (!out.success) return out;
		const parsed = devicectlJson.parse(out.data, "devicectl lockState");
		if (!parsed.success) return parsed;
		const passcodeRequired = devicectlJson.passcodeRequired(parsed.data);
		if (typeof passcodeRequired !== "boolean")
			return resultFactory.err("devicectl lockState: missing `passcodeRequired`");
		return resultFactory.ok({ locked: passcodeRequired });
	}

	/**
	 * Is the phone reachable. A locked phone passes: locked is a state `warden ui` reports as `device_locked`, not a
	 * broken device, and warden never unlocks one.
	 */
	async probe(udid: string): AsyncResult<void> {
		const state = await this.readLockState(udid);
		return state.success ? resultFactory.ok(undefined) : state;
	}

	/** Run `cmd` for stdout, bounded by `timeoutMs`; a hang, a non-zero exit or a missing binary is an error. */
	private async run(cmd: string[], timeoutMs: number): AsyncResult<string> {
		const result = await this.bounded.within(cmd, timeoutMs);
		if (result === undefined)
			return resultFactory.err(`\`${cmd.join(" ")}\` did not finish within ${Math.round(timeoutMs / 1000)}s`);
		return result.exitCode === 0 ? resultFactory.ok(result.stdout) : resultFactory.err(execErrors.format(cmd, result));
	}

	/** Connected right now without asking: a wired transport or an up tunnel. */
	private connectedNow(d: InventoryDevice): boolean {
		return (
			d.physical?.platform === "ios" && (d.physical.transport === "wired" || d.physical.tunnelState === "connected")
		);
	}

	/**
	 * devicectl lists every paired device, including iPads in a drawer, as available. A ready-looking phone that is not
	 * connected (no wired transport, tunnel down) must answer a bounded `lockState` to count; otherwise it is
	 * `shutdown` with the reason in `PhysicalInfo.unreachable`, so no claim ever auto-picks it.
	 */
	private async markReachability(d: InventoryDevice, probeMs: number): Promise<InventoryDevice> {
		if (d.state !== "booted" || d.physical?.platform !== "ios" || this.connectedNow(d)) return d;
		const answer = await this.bounded.within(devicectlArgv.lockState(d.id, probeMs), probeMs);
		const parsed =
			answer !== undefined && answer.exitCode === 0 ? devicectlJson.parse(answer.stdout, "lockState") : undefined;
		if (parsed?.success) {
			// an answer means reachable even when locked; `passcodeRequired` is true while the phone is locked
			const passcodeRequired = devicectlJson.passcodeRequired(parsed.data);
			return typeof passcodeRequired === "boolean"
				? { ...d, physical: { ...d.physical, locked: passcodeRequired } }
				: d;
		}
		const reason =
			answer === undefined
				? `no answer within ${probeMs / 1000}s (not connected)`
				: answer.stderr.trim().split("\n")[0] || "not connected";
		return { ...d, state: "shutdown", physical: { ...d.physical, unreachable: reason } };
	}
}
