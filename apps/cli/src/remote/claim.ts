import type { NewLease } from "@delacour/warden-core/store";
import type { Lease, Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { WardenApi } from "./api";
import type { CreateRemoteDevice, RemoteDevice } from "./api.types";
import { authedApi } from "./session";

export type RemoteClaimInput = {
	platform: Platform;
	/** device model (`--profile`); unset = warden-api's default for the platform */
	profile?: string;
	/** OS version (`--runtime`) */
	runtime?: string;
	ttlMs: number;
	/** how long to wait for the hosted device to boot */
	waitMs: number;
	owner: Owner;
	label?: string;
	pid?: number;
};

export type RemoteClaim = { lease: Lease; device: RemoteDevice };

const POLL_MS = 2000;

function createRequest(input: RemoteClaimInput): CreateRemoteDevice {
	return {
		platform: input.platform,
		...(input.profile ? { deviceModel: input.profile } : {}),
		...(input.runtime ? { osVersion: input.runtime } : {}),
		idleTimeoutS: Math.max(60, Math.round(input.ttlMs / 1000)),
	};
}

function notReady(input: RemoteClaimInput, device: RemoteDevice): string {
	const why =
		device.status === "starting"
			? `not ready after ${Math.round(input.waitMs / 1000)}s`
			: `${device.status}${device.error ? `: ${device.error}` : ""}`;
	return `remote ${input.platform} device ${device.id} ${why}`;
}

function newLease(input: RemoteClaimInput, device: RemoteDevice): NewLease {
	return {
		resource: {
			kind: "remote-device",
			platform: device.platform,
			id: device.id,
			name: device.deviceModel ?? `${device.platform}-remote`,
		},
		owner: input.owner,
		ttlMs: input.ttlMs,
		...(input.label ? { label: input.label } : {}),
		...(input.pid !== undefined ? { pid: input.pid } : {}),
	};
}

/** Poll a starting device until it leaves `starting` or the deadline passes; returns its last known state. */
async function waitForReady(
	api: WardenApi,
	initial: RemoteDevice,
	deadline: number,
	now: () => number,
	sleep: (ms: number) => Promise<void>
): AsyncResult<RemoteDevice> {
	let device = initial;
	while (device.status === "starting" && now() < deadline) {
		await sleep(POLL_MS);
		const polled = await api.getDevice(device.id);
		if (!polled.success) return err(polled.error.message);
		device = polled.data;
	}
	return ok(device);
}

/**
 * Lease a hosted device: ask warden-api for one, poll until it is ready, then record a `remote-device` lease in
 * the local store so `ls` / `release` / heartbeats treat it like any other. The device's idle timeout follows the
 * lease TTL, so a forgotten lease stops costing money server-side too. A device that never comes up is stopped.
 */
export async function claimRemote(ctx: CommandContext, input: RemoteClaimInput): AsyncResult<RemoteClaim> {
	const authed = authedApi(ctx);
	if (!authed.success) return authed;
	const { api } = authed.data;
	const sleep = ctx.sleep ?? ((ms: number) => Bun.sleep(ms));
	const created = await api.createDevice(createRequest(input));
	if (!created.success) return err(created.error.message);

	const ready = await waitForReady(api, created.data, ctx.now() + input.waitMs, ctx.now, sleep);
	if (!ready.success) return ready;
	const device = ready.data;
	if (device.status !== "ready") {
		const stop = await api.stopDevice(device.id);
		return err(`${notReady(input, device)}${stop.success ? " (stopped it)" : ""}`);
	}

	const lease = ctx.store().insertLease(newLease(input, device), ctx.now());
	return ok({ lease, device });
}

/** Stop the hosted devices behind `leases` (non-remote ones are skipped); a failure is a note, never fatal. */
export async function stopRemoteLeases(
	ctx: CommandContext,
	leases: readonly Lease[]
): Promise<{ stopped: string[]; notes: string[] }> {
	const remote = leases.flatMap((l) => (l.resource.kind === "remote-device" ? [l.resource.id] : []));
	if (remote.length === 0) return { stopped: [], notes: [] };
	const authed = authedApi(ctx);
	if (!authed.success) return { stopped: [], notes: remote.map((id) => `remote device ${id}: ${authed.error}`) };
	const results = await Promise.all(remote.map(async (id) => ({ id, result: await authed.data.api.stopDevice(id) })));
	return {
		stopped: results.flatMap((r) => (r.result.success ? [r.id] : [])),
		notes: results.flatMap((r) => (r.result.success ? [] : [`remote device ${r.id}: ${r.result.error.message}`])),
	};
}

/** Keep the hosted devices behind `leases` from idling out; returns a note per device that could not be reached. */
export async function heartbeatRemoteLeases(ctx: CommandContext, leases: readonly Lease[]): Promise<string[]> {
	const remote = leases.flatMap((l) => (l.resource.kind === "remote-device" ? [l.resource.id] : []));
	if (remote.length === 0) return [];
	const authed = authedApi(ctx);
	if (!authed.success) return remote.map((id) => `remote device ${id}: ${authed.error}`);
	const results = await Promise.all(remote.map(async (id) => ({ id, r: await authed.data.api.heartbeatDevice(id) })));
	return results.flatMap(({ id, r }) => (r.success ? [] : [`remote device ${id}: ${r.error.message}`]));
}
