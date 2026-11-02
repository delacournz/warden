import type { NewLease } from "@delacour/warden-core/store";
import type { Lease, Owner, Platform } from "@delacour/warden-core/types";
import { type AsyncResult, type ErrorResult, ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { WardenApi } from "./api";
import type { CreateRemoteDevice, RemoteDevice, StopReason } from "./api.types";
import { type CloudFailure, cloudFailure } from "./errors";
import { machineDepsFor, machineHash } from "./machine";
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

const fail = (error: CloudFailure): ErrorResult<CloudFailure> => ({ success: false, error });

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
): AsyncResult<RemoteDevice, CloudFailure> {
	let device = initial;
	while (device.status === "starting" && now() < deadline) {
		await sleep(POLL_MS);
		const polled = await api.getDevice(device.id);
		if (!polled.success) return fail(cloudFailure(polled.error));
		device = polled.data;
	}
	return ok(device);
}

/**
 * Lease a hosted device: ask warden-api for one, poll until it is ready, then record a `remote-device` lease in
 * the local store so `ls` / `release` / heartbeats treat it like any other. The device's idle timeout follows the
 * lease TTL, so a forgotten lease stops costing money server-side too. A device that never comes up is stopped.
 * The hashed machine id rides along as `X-Warden-Machine` (it unlocks the free trial); none is fine for paid use.
 */
export async function claimRemote(
	ctx: CommandContext,
	input: RemoteClaimInput
): AsyncResult<RemoteClaim, CloudFailure> {
	const authed = authedApi(ctx);
	if (!authed.success) return fail({ message: authed.error });
	const { api } = authed.data;
	const sleep = ctx.sleep ?? ((ms: number) => Bun.sleep(ms));
	const machine = await machineHash(machineDepsFor(ctx));
	const created = await api.createDevice(
		createRequest(input),
		machine.kind === "found" ? { machine: machine.hash } : {}
	);
	if (!created.success) return fail(cloudFailure(created.error));

	const ready = await waitForReady(api, created.data, ctx.now() + input.waitMs, ctx.now, sleep);
	if (!ready.success) return ready;
	const device = ready.data;
	if (device.status !== "ready") {
		const stop = await api.stopDevice(device.id);
		return fail({ message: `${notReady(input, device)}${stop.success ? " (stopped it)" : ""}` });
	}

	const lease = ctx.store().insertLease(newLease(input, device), ctx.now());
	return ok({ lease, device });
}

/** `out of credits` for `credits_exhausted`, and so on: how a stop reason reads in a note. */
export function describeStopReason(reason: StopReason): string {
	switch (reason) {
		case "credits_exhausted":
			return "out of credits; top up with: warden billing --top-up";
		case "idle":
			return "idle timeout";
		case "user":
			return "stopped by a user";
		case "error":
			return "device error";
	}
}

export type RemoteStopOutcome = {
	stopped: string[];
	notes: string[];
	/** devices warden cloud had already stopped, and why (`credits_exhausted`, `idle`, …) */
	stopReasons: Record<string, StopReason>;
};

/**
 * Stop the hosted devices behind `leases` (non-remote ones are skipped); a failure is a note, never fatal. A device
 * the server already stopped (out of credits, idle) reports its `stopReason`, so the user learns why it went away.
 */
export async function stopRemoteLeases(ctx: CommandContext, leases: readonly Lease[]): Promise<RemoteStopOutcome> {
	const remote = leases.flatMap((l) => (l.resource.kind === "remote-device" ? [l.resource.id] : []));
	if (remote.length === 0) return { stopped: [], notes: [], stopReasons: {} };
	const authed = authedApi(ctx);
	if (!authed.success) {
		return { stopped: [], notes: remote.map((id) => `remote device ${id}: ${authed.error}`), stopReasons: {} };
	}
	const { api } = authed.data;
	const results = await Promise.all(
		remote.map(async (id) => {
			const before = await api.getDevice(id);
			const reason = before.success && before.data.status === "stopped" ? before.data.stopReason : undefined;
			return { id, reason, result: await api.stopDevice(id) };
		})
	);
	const stopReasons: Record<string, StopReason> = {};
	for (const r of results) if (r.reason) stopReasons[r.id] = r.reason;
	return {
		stopped: results.flatMap((r) => (r.result.success ? [r.id] : [])),
		notes: results.flatMap((r) => [
			...(r.reason
				? [`remote device ${r.id} had stopped (stop_reason: ${r.reason}): ${describeStopReason(r.reason)}`]
				: []),
			...(r.result.success ? [] : [`remote device ${r.id}: ${r.result.error.message}`]),
		]),
		stopReasons,
	};
}

/** A heartbeat answer worth telling the user about: the device was stopped, or the balance is about to run out. */
function heartbeatNote(device: RemoteDevice): string | undefined {
	if (device.status === "stopped" && device.stopReason) {
		return `remote device ${device.id} stopped: ${describeStopReason(device.stopReason)}`;
	}
	if (device.billing?.lowBalance) {
		return `remote device ${device.id}: low balance ($${device.billing.balanceUsd.toFixed(2)} left); top up with: warden billing --top-up`;
	}
	return undefined;
}

/**
 * Keep the hosted devices behind `leases` from idling out; returns a warning per device that could not be reached,
 * was stopped (`credits_exhausted`, …) or whose organization is low on credits.
 */
export async function heartbeatRemoteLeases(ctx: CommandContext, leases: readonly Lease[]): Promise<string[]> {
	const remote = leases.flatMap((l) => (l.resource.kind === "remote-device" ? [l.resource.id] : []));
	if (remote.length === 0) return [];
	const authed = authedApi(ctx);
	if (!authed.success) return remote.map((id) => `remote device ${id}: ${authed.error}`);
	const results = await Promise.all(remote.map(async (id) => ({ id, r: await authed.data.api.heartbeatDevice(id) })));
	return results.flatMap(({ id, r }) => {
		if (!r.success) return [`remote device ${id}: ${r.error.message}`];
		const note = heartbeatNote(r.data);
		return note ? [note] : [];
	});
}

/**
 * Why warden cloud stopped the hosted devices behind `leases`, for `warden ls`. Best effort: not logged in, a
 * network error or no answer within `timeoutMs` reads as nothing to report.
 */
export async function remoteStopReasons(
	ctx: CommandContext,
	leases: readonly Lease[],
	timeoutMs = 3000
): Promise<Record<string, StopReason>> {
	const remote = leases.flatMap((l) => (l.resource.kind === "remote-device" ? [l.resource.id] : []));
	const authed = remote.length > 0 ? authedApi(ctx) : undefined;
	if (!authed?.success) return {};
	const lookups = Promise.all(remote.map(async (id) => ({ id, r: await authed.data.api.getDevice(id) })));
	const timeout = new Promise<[]>((done) => setTimeout(() => done([]), timeoutMs).unref?.());
	const results = await Promise.race([lookups, timeout]);
	const reasons: Record<string, StopReason> = {};
	for (const { id, r } of results) {
		if (r.success && r.data.status === "stopped" && r.data.stopReason) reasons[id] = r.data.stopReason;
	}
	return reasons;
}
