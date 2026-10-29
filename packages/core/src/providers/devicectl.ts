import { type AsyncResult, err, ok, type Result } from "@delacour/warden-types/result";
import { execError } from "../exec";
import type { InventoryDevice, PhysicalInfo } from "../types";
import { execWithin, type TimedExec } from "./health";

/**
 * Real iPhones and iPads through `xcrun devicectl`: listing for inventory and a reachability probe. devicectl
 * prints JSON to stdout with `--json-output -` (progress goes to stderr, silenced by `--quiet`). Nothing here
 * boots, installs or changes a device.
 */

/** Far above normal times (~0.1 s list): only ends a hang, so a sim claim never waits on a wedged CoreDevice. */
export const DEVICECTL_TIMEOUTS = { listMs: 15_000, probeMs: 15_000 } as const;

export const listDevicesArgv = (): string[] => [
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

/** How long a phone that is not connected right now gets to answer `lockState` before it counts as offline (devicectl's `--timeout` floor is 5 s). */
export const REACHABLE_PROBE_MS = 5_000;

/** The wait for a phone the caller named (`--udid`, `physical.ids`, `WARDEN_UDID`): an idle phone may need that long to bring its CoreDevice tunnel up. */
export const NAMED_PROBE_MS = 20_000;

export const lockStateArgv = (udid: string, timeoutMs?: number): string[] => [
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
	String(timeoutMs === undefined ? DEVICECTL_TIMEOUTS.probeMs / 1000 - 5 : Math.max(5, Math.ceil(timeoutMs / 1000))),
];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function obj(parent: JsonObject | undefined, key: string): JsonObject | undefined {
	const value = parent?.[key];
	return isObject(value) ? value : undefined;
}

function str(parent: JsonObject | undefined, key: string): string | undefined {
	const value = parent?.[key];
	return typeof value === "string" && value !== "" ? value : undefined;
}

function parseJson(stdout: string, what: string): Result<JsonObject> {
	try {
		const value: unknown = JSON.parse(stdout);
		return isObject(value) ? ok(value) : err(`${what}: expected a JSON object`);
	} catch (error) {
		return err(`${what}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
}

/** `developerModeStatus`: the string `enabled` (deprecated block) or `{ enabled: {…} }` (`properties.state`). */
function developerModeOn(...statuses: unknown[]): boolean {
	return statuses.some((s) => s === "enabled" || (isObject(s) && "enabled" in s));
}

function physicalInfo(entry: JsonObject): PhysicalInfo {
	const props = obj(entry, "properties");
	// devicectl is moving to `properties`; the deprecated blocks are still what carries `ddiServicesAvailable`
	const hardware = obj(entry, "hardwareProperties") ?? obj(props, "hardware");
	const device = obj(entry, "deviceProperties");
	const connection = obj(entry, "connectionProperties") ?? obj(props, "connection");
	const software = obj(obj(props, "software"), "osVersionNumber");
	const tunnelIp = str(connection, "tunnelIPAddress") ?? str(connection, "tunnelIPAddressString");
	const pairingState = str(connection, "pairingState") ?? "unknown";
	const tunnelState = str(connection, "tunnelState");
	return {
		platform: "ios",
		transport: str(connection, "transportType") === "wired" ? "wired" : "localNetwork",
		deviceType: str(hardware, "deviceType") ?? "unknown",
		osVersion: str(device, "osVersionNumber") ?? str(software, "stringValue") ?? "unknown",
		developerMode: developerModeOn(device?.developerModeStatus, obj(props, "state")?.developerModeStatus),
		ddi: device?.ddiServicesAvailable === true,
		...(tunnelIp === undefined ? {} : { tunnelIp }),
		...(tunnelState === undefined ? {} : { tunnelState }),
		...(pairingState === "paired" ? {} : { pairingState }),
	};
}

function toDevice(entry: unknown): InventoryDevice | undefined {
	if (!isObject(entry)) return undefined;
	const props = obj(entry, "properties");
	const hardware = obj(entry, "hardwareProperties") ?? obj(props, "hardware");
	const platform = str(hardware, "platform");
	if (str(hardware, "reality") !== "physical" || (platform !== "iOS" && platform !== "iPadOS")) return undefined;
	const udid = str(hardware, "udid");
	if (udid === undefined) return undefined;
	const physical = physicalInfo(entry);
	const ready = physical.platform === "ios" && physical.pairingState === undefined && physical.developerMode;
	return {
		platform: "ios",
		id: udid,
		name: str(obj(entry, "deviceProperties"), "name") ?? str(obj(props, "state"), "name") ?? udid,
		state: ready ? "booted" : "shutdown",
		wardenCreated: false,
		physical,
	};
}

/**
 * Flatten `devicectl list devices` JSON into physical iOS inventory. Simulators (`reality: simulated`), watches
 * and TVs are dropped. A device is `booted` (ready) when paired with Developer Mode on; otherwise `shutdown`,
 * with `developerMode` / `pairingState` in its `PhysicalInfo` saying why.
 */
export function parseDevicectlDevices(stdout: string): Result<InventoryDevice[]> {
	const parsed = parseJson(stdout, "devicectl list devices");
	if (!parsed.success) return parsed;
	const result = obj(parsed.data, "result");
	const devices = result?.devices;
	if (!Array.isArray(devices)) return err("devicectl list devices: missing `result.devices`");
	return ok(devices.flatMap((entry) => toDevice(entry) ?? []));
}

/** Run `cmd` for stdout, bounded by `timeoutMs`; a hang, a non-zero exit or a missing binary is an error. */
async function runDevicectl(runner: TimedExec, cmd: string[], timeoutMs: number): AsyncResult<string> {
	const result = await execWithin(runner, cmd, timeoutMs);
	if (result === undefined) return err(`\`${cmd.join(" ")}\` did not finish within ${Math.round(timeoutMs / 1000)}s`);
	return result.exitCode === 0 ? ok(result.stdout) : err(execError(cmd, result));
}

/** Connected right now without asking: a wired transport or an up tunnel. */
function connectedNow(d: InventoryDevice): boolean {
	return d.physical?.platform === "ios" && (d.physical.transport === "wired" || d.physical.tunnelState === "connected");
}

/**
 * devicectl lists every paired device, including iPads in a drawer, as available. A ready-looking phone that is not
 * connected (no wired transport, tunnel down) must answer a bounded `lockState` to count; otherwise it is
 * `shutdown` with the reason in `PhysicalInfo.unreachable`, so no claim ever auto-picks it.
 */
async function markReachability(runner: TimedExec, d: InventoryDevice, probeMs: number): Promise<InventoryDevice> {
	if (d.state !== "booted" || d.physical?.platform !== "ios" || connectedNow(d)) return d;
	const answer = await execWithin(runner, lockStateArgv(d.id, probeMs), probeMs);
	const parsed = answer !== undefined && answer.exitCode === 0 ? parseJson(answer.stdout, "lockState") : undefined;
	if (parsed?.success) {
		// an answer means reachable even when locked; `passcodeRequired` is true while the phone is locked
		const passcodeRequired = obj(parsed.data, "result")?.passcodeRequired;
		return typeof passcodeRequired === "boolean" ? { ...d, physical: { ...d.physical, locked: passcodeRequired } } : d;
	}
	const reason =
		answer === undefined
			? `no answer within ${probeMs / 1000}s (not connected)`
			: answer.stderr.trim().split("\n")[0] || "not connected";
	return { ...d, state: "shutdown", physical: { ...d.physical, unreachable: reason } };
}

/** Physical iPhones/iPads CoreDevice knows about. An error (no Xcode, devicectl wedged) is the caller's to ignore. */
export async function listPhysicalIos(
	runner: TimedExec,
	opts: { named?: readonly string[] } = {}
): AsyncResult<InventoryDevice[]> {
	const out = await runDevicectl(runner, listDevicesArgv(), DEVICECTL_TIMEOUTS.listMs);
	if (!out.success) return out;
	const parsed = parseDevicectlDevices(out.data);
	return parsed.success
		? ok(
				await Promise.all(
					parsed.data.map((d) =>
						markReachability(runner, d, opts.named?.includes(d.id) ? NAMED_PROBE_MS : REACHABLE_PROBE_MS)
					)
				)
			)
		: parsed;
}

/** `devicectl device info lockState`: is a passcode needed to use the phone now. */
export async function readLockState(runner: TimedExec, udid: string): AsyncResult<{ locked: boolean }> {
	const out = await runDevicectl(runner, lockStateArgv(udid), DEVICECTL_TIMEOUTS.probeMs);
	if (!out.success) return out;
	const parsed = parseJson(out.data, "devicectl lockState");
	if (!parsed.success) return parsed;
	const passcodeRequired = obj(parsed.data, "result")?.passcodeRequired;
	if (typeof passcodeRequired !== "boolean") return err("devicectl lockState: missing `passcodeRequired`");
	return ok({ locked: passcodeRequired });
}

/**
 * Is the phone reachable. A locked phone passes: locked is a state `warden ui` reports as `device_locked`, not a
 * broken device, and warden never unlocks one.
 */
export async function probePhysicalIos(runner: TimedExec, udid: string): AsyncResult<void> {
	const state = await readLockState(runner, udid);
	return state.success ? ok(undefined) : state;
}
