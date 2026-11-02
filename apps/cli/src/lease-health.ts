import type { Exec } from "@delacour/warden-core/exec";
import type { LeaseEventPayloads } from "@delacour/warden-core/lease-events";
import { androidTools } from "@delacour/warden-core/providers/android";
import { shouldShutdown } from "@delacour/warden-core/shutdown-policy";
import { parseAllSims } from "@delacour/warden-core/sims/list";
import { ownerKey } from "@delacour/warden-core/store";
import { isPhysicalIosId, type Lease, type Resource, resourceKey } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { CommandContext } from "./context";
import { errorMessage } from "./hooks/json";
import { ownedElsewhere } from "./marker-guard";

/**
 * Health monitor under a held lease (`run` / `dev` / `batch` / `e2e`). Each heartbeat tick reads every
 * leased device once; a device with `UNHEALTHY_AFTER` bad reads in a row is rebooted under the same
 * lease (the lease id never changes). Recovery waits `RECOVERY_BACKOFF_MS[i]` before attempt `i + 1`
 * (5 s, 10 s, 20 s) and gives up after the last. One recovery runs at a time per holder, and a tick
 * that finds the previous pass still running does nothing, so probes never overlap.
 *
 * A physical device, or one warden neither created nor booted, is never rebooted: it is reported
 * (`device_unhealthy` event + a stderr warning) and the run goes on.
 */

/** Bad reads in a row before a device counts as unhealthy. */
export const UNHEALTHY_AFTER = 2;
/** Wait before recovery attempt 1, 2, 3; the list length is the attempt cap. */
export const RECOVERY_BACKOFF_MS: readonly number[] = [5_000, 10_000, 20_000];
/** How long one reboot may take to come back ready. */
export const RECOVERY_READY_MS = 120_000;
/** `simctl list` / `adb get-state` must answer in this long. */
const PROBE_TIMEOUT_MS = 10_000;

/** A leased device resource. */
export type DeviceResource = Extract<Resource, { kind: "device" }>;
export type LeasedDevice = Lease & { resource: DeviceResource };

/** One device's read. A device with no reading this tick (the probe could not tell) keeps its count. */
export type Reading = { ok: true } | { ok: false; reason: string };

export type LeaseHealthDeps = {
	/** One read per tick for all `devices` (iOS: one `simctl list` for every sim). Devices it cannot judge are absent. */
	probe: (ctx: CommandContext, devices: readonly LeasedDevice[]) => Promise<Map<string, Reading>>;
	/** Reboot the device under its lease; resolves when it is ready again. */
	recover: (ctx: CommandContext, device: LeasedDevice) => AsyncResult<void>;
	sleep: (ms: number) => Promise<void>;
};

export type LeaseHealth = {
	/** One monitor pass; returns at once, and does nothing while the previous pass is still running. */
	tick: () => void;
};

export function healthMonitorDisabled(env: Record<string, string | undefined>): boolean {
	const value = env.WARDEN_HEALTH_MONITOR?.trim().toLowerCase();
	return value === "0" || value === "off" || value === "false" || value === "no";
}

const reasonOf = (reading: Reading): string => (reading.ok ? "" : reading.reason);

type Tracked = { bad: number; reason: string; reported: boolean };

/**
 * `giveUp(message)` runs once, when a device could not be recovered. `active()` turns false once the
 * holder is stopped or its leases are gone; the monitor then writes nothing more.
 */
export function createLeaseHealth(
	ctx: CommandContext,
	deps: LeaseHealthDeps,
	leaseIds: readonly string[],
	hooks: { active: () => boolean; giveUp: (message: string) => void }
): LeaseHealth {
	const tracked = new Map<string, Tracked>();
	let running = false;

	const leasedDevices = (): LeasedDevice[] => {
		const out: LeasedDevice[] = [];
		for (const id of leaseIds) {
			const lease = ctx.store().getLease(id);
			if (lease?.resource.kind === "device" && !lease.resource.id.startsWith("pending:")) {
				out.push({ ...lease, resource: lease.resource });
			}
		}
		return out;
	};

	const log = (device: LeasedDevice, event: HealthEvent) => record(ctx, event, device);

	const recoverOne = async (device: LeasedDevice, reason: string): Promise<boolean> => {
		const started = ctx.now();
		let lastError = reason;
		for (const [i, backoff] of RECOVERY_BACKOFF_MS.entries()) {
			await deps.sleep(backoff);
			if (!hooks.active()) return true;
			ctx.err(
				`warden: rebooting ${device.resource.name} (${device.resource.id}) under its lease, attempt ${i + 1}/${RECOVERY_BACKOFF_MS.length}`
			);
			const result = await recoverSafely(deps, ctx, device);
			if (result.success) {
				if (!hooks.active()) return true;
				log(device, {
					type: "device_recovered",
					data: {
						platform: device.resource.platform,
						deviceId: device.resource.id,
						attempts: i + 1,
						durationMs: Math.max(0, ctx.now() - started),
					},
				});
				return true;
			}
			lastError = result.error;
		}
		hooks.giveUp(
			`${device.resource.name} (${device.resource.id}) died (${reason}) and could not be recovered after ${RECOVERY_BACKOFF_MS.length} reboot attempts: ${lastError}`
		);
		return false;
	};

	/** Count one reading; true when the device just became unhealthy and may be rebooted. */
	const observe = (device: LeasedDevice, reading: Reading, wardenDevices: ReadonlySet<string>): boolean => {
		const state = tracked.get(device.id) ?? { bad: 0, reason: "", reported: false };
		tracked.set(device.id, state);
		if (reading.ok) {
			state.bad = 0;
			state.reported = false;
			return false;
		}
		state.bad++;
		if (state.bad < UNHEALTHY_AFTER || state.reported) return false;
		state.reported = true;
		log(device, {
			type: "device_unhealthy",
			data: {
				platform: device.resource.platform,
				deviceId: device.resource.id,
				reason: reading.reason,
				consecutive: state.bad,
			},
		});
		if (shouldShutdown(device, wardenDevices, ownedElsewhere(ctx))) return true;
		ctx.err(
			`warden: warning: ${device.resource.name} (${device.resource.id}) is unhealthy (${reading.reason}); not rebooting a device warden did not create (run goes on)`
		);
		return false;
	};

	const recoverDue = async (due: ReadonlyArray<{ device: LeasedDevice; reason: string }>): Promise<void> => {
		for (const { device, reason } of due) {
			if (!hooks.active() || !(await recoverOne(device, reason))) return;
			tracked.set(device.id, { bad: 0, reason: "", reported: false });
		}
	};

	const pass = async (): Promise<void> => {
		const devices = leasedDevices();
		const readings = await deps.probe(ctx, devices).catch((): Map<string, Reading> => new Map());
		if (!hooks.active()) return;
		const wardenDevices = new Set(
			ctx
				.store()
				.listDevices()
				.map((d) => `${d.platform}:${d.id}`)
		);
		const due: Array<{ device: LeasedDevice; reason: string }> = [];
		for (const device of devices) {
			const reading = readings.get(device.resource.id);
			if (reading && observe(device, reading, wardenDevices)) due.push({ device, reason: reasonOf(reading) });
		}
		await recoverDue(due);
	};

	return {
		tick() {
			if (running || !hooks.active()) return;
			running = true;
			pass()
				.catch(() => {
					// a monitor failure never stops the run: the next tick looks again
				})
				.finally(() => {
					running = false;
				});
		},
	};
}

async function recoverSafely(deps: LeaseHealthDeps, ctx: CommandContext, device: LeasedDevice): AsyncResult<void> {
	try {
		return await deps.recover(ctx, device);
	} catch (error) {
		return err(errorMessage(error));
	}
}

type HealthEvent =
	| { type: "device_unhealthy"; data: LeaseEventPayloads["device_unhealthy"] }
	| { type: "device_recovered"; data: LeaseEventPayloads["device_recovered"] };

function record(ctx: CommandContext, event: HealthEvent, device: LeasedDevice): void {
	try {
		const store = ctx.store();
		store.transaction(() => {
			store.recordEvent({
				...event,
				at: ctx.now(),
				leaseId: device.id,
				resourceKey: resourceKey(device.resource),
				ownerKey: ownerKey(device.owner),
				...(device.label !== undefined ? { label: device.label } : {}),
				...(device.claimId !== undefined ? { claimId: device.claimId } : {}),
			});
		});
	} catch {
		// the log is best-effort: a busy store never stops the run
	}
}

// ---- default probe / recover (real simctl, adb, providers) ----

const KILLED = new Set([124, 143]);

async function probeSims(exec: Exec, sims: readonly LeasedDevice[]): Promise<Map<string, Reading>> {
	const out = new Map<string, Reading>();
	if (sims.length === 0) return out;
	let listed: Awaited<ReturnType<Exec>>;
	try {
		listed = await exec(["xcrun", "simctl", "list", "devices", "-j"], { timeoutMs: PROBE_TIMEOUT_MS });
	} catch {
		return out;
	}
	if (listed.exitCode !== 0) return out;
	const parsed = parseAllSims(listed.stdout);
	if (!parsed.success) return out;
	const byUdid = new Map(parsed.data.map((s) => [s.udid, s.state]));
	for (const sim of sims) {
		const state = byUdid.get(sim.resource.id);
		if (state === "Booted") out.set(sim.resource.id, { ok: true });
		else
			out.set(sim.resource.id, {
				ok: false,
				reason: state === undefined ? "missing from simctl" : `simctl state ${state}`,
			});
	}
	return out;
}

async function probeAdb(ctx: CommandContext, device: LeasedDevice): Promise<Reading | undefined> {
	const { adb } = androidTools(ctx.env);
	try {
		const res = await ctx.exec([adb, "-s", device.resource.id, "get-state"], { timeoutMs: PROBE_TIMEOUT_MS });
		if (res.exitCode === 0 && res.stdout.trim() === "device") return { ok: true };
		if (KILLED.has(res.exitCode)) return { ok: false, reason: "adb get-state did not answer" };
		const said = (res.exitCode === 0 ? res.stdout : res.stderr).trim().split("\n")[0] ?? "";
		return { ok: false, reason: `adb get-state: ${said || `exit ${res.exitCode}`}` };
	} catch {
		return undefined;
	}
}

/** Real reads: one `simctl list devices -j` for every simulator, `adb -s <serial> get-state` per Android device. */
export async function probeDevices(
	ctx: CommandContext,
	devices: readonly LeasedDevice[]
): Promise<Map<string, Reading>> {
	const sims = devices.filter((d) => d.resource.platform === "ios" && !isPhysicalIosId(d.resource.id));
	const out = await probeSims(ctx.exec, sims);
	const droids = devices.filter((d) => d.resource.platform === "android");
	const reads = await Promise.all(droids.map((d) => probeAdb(ctx, d)));
	for (const [i, read] of reads.entries()) {
		const droid = droids[i];
		if (droid && read) out.set(droid.resource.id, read);
	}
	return out;
}

/**
 * Reboot under the lease. iOS: stop the resident helper (bound to the boot that ended), `simctl
 * shutdown`, then boot + wait ready. Android: `adb reboot` (the serial and the emulator process
 * survive, so the lease stays valid), then wait for the OS.
 */
export async function recoverDevice(ctx: CommandContext, device: LeasedDevice): AsyncResult<void> {
	const { id, platform } = device.resource;
	const { providerFor } = await import("./providers");
	const provider = providerFor(platform, ctx, device.owner);
	if (platform === "android") {
		const { adb } = androidTools(ctx.env);
		const rebooted = await ctx.exec([adb, "-s", id, "reboot"], { timeoutMs: PROBE_TIMEOUT_MS });
		if (rebooted.exitCode !== 0)
			return err(`adb reboot ${id} failed: ${rebooted.stderr.trim() || `exit ${rebooted.exitCode}`}`);
		await ctx.exec([adb, "-s", id, "wait-for-device"], { timeoutMs: RECOVERY_READY_MS });
		return provider.waitReady(id, RECOVERY_READY_MS);
	}
	const { stopHelperAfter } = await import("./agent-ui/stop-helper-after");
	await stopHelperAfter(ctx)(id);
	const down = await provider.shutdown(id);
	if (!down.success) return down;
	if (provider.bootReady) {
		const ready = await provider.bootReady(id, RECOVERY_READY_MS);
		return ready.kind === "ready" ? ok(undefined) : err(ready.error);
	}
	const booted = await provider.boot(id);
	return booted.success ? provider.waitReady(id, RECOVERY_READY_MS) : booted;
}

export const defaultLeaseHealthDeps: LeaseHealthDeps = {
	probe: probeDevices,
	recover: recoverDevice,
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
