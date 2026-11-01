import type { NewLease } from "@delacour/warden-core/store";
import type { Lease, Owner, Platform, RemoteDeviceResource } from "@delacour/warden-core/types";
import { type AsyncResult, type ErrorResult, ok } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import type { WardenApi } from "./api";
import type { CreateRemoteDevice, RemoteDevice, StopReason } from "./api.types";
import type { AuthPin } from "./context";
import { type CloudFailure, cloudFailure } from "./errors";
import { machineDepsFor, machineHash } from "./machine";
import { type Authed, authedApi, pinOf } from "./session";

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

/** `billedTo` = the account and org the device was claimed under (and why), for the claim's note. */
export type RemoteClaim = { lease: Lease; device: RemoteDevice; billedTo: BilledTo };

export type BilledTo = Pick<Authed, "organization" | "orgVia"> & { account?: string; link?: string };

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

function newLease(input: RemoteClaimInput, device: RemoteDevice, pin: AuthPin): NewLease {
	return {
		resource: {
			kind: "remote-device",
			platform: device.platform,
			id: device.id,
			name: device.deviceModel ?? `${device.platform}-remote`,
			...pin,
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

	const authedData = authed.data;
	const lease = ctx.store().insertLease(newLease(input, device, pinOf(authedData)), ctx.now());
	const billedTo: BilledTo = {
		orgVia: authedData.orgVia,
		...(authedData.organization ? { organization: authedData.organization } : {}),
		...(authedData.source === "saved" ? { account: authedData.account } : {}),
		...(authedData.source === "saved" && authedData.link
			? { link: authedData.link.kind === "path" ? authedData.link.path : authedData.link.remote }
			: {}),
	};
	return ok({ lease, device, billedTo });
}

type RemoteLease = Lease & { resource: RemoteDeviceResource };

function remoteLeases(leases: readonly Lease[]): RemoteLease[] {
	return leases.filter((l): l is RemoteLease => l.resource.kind === "remote-device");
}

/** The account + org a remote lease was claimed under; empty for leases from before named accounts. */
export function leasePin(lease: RemoteLease): AuthPin {
	const { account, organizationId } = lease.resource;
	return { ...(account ? { account } : {}), ...(organizationId ? { organizationId } : {}) };
}

/**
 * Device ids grouped by the client that can reach them (each lease's own account + org), or the auth error per
 * group: one authed client per distinct pin, so leases from two orgs are each stopped in their own.
 */
function byClient(
	ctx: CommandContext,
	leases: readonly Lease[]
): Array<{ ids: string[]; authed: ReturnType<typeof authedApi> }> {
	const groups = new Map<string, { pin: AuthPin; ids: string[] }>();
	for (const lease of remoteLeases(leases)) {
		const pin = leasePin(lease);
		const key = `${pin.account ?? ""}\u0000${pin.organizationId ?? ""}`;
		const group = groups.get(key) ?? { pin, ids: [] };
		group.ids.push(lease.resource.id);
		groups.set(key, group);
	}
	return [...groups.values()].map(({ pin, ids }) => ({ ids, authed: authedApi(ctx, pin) }));
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
	const groups = byClient(ctx, leases);
	if (groups.length === 0) return { stopped: [], notes: [], stopReasons: {} };
	const authNotes = groups.flatMap((g) =>
		g.authed.success ? [] : g.ids.map((id) => `remote device ${id}: ${g.authed.success ? "" : g.authed.error}`)
	);
	const results = (
		await Promise.all(
			groups.map(async ({ ids, authed }) => {
				if (!authed.success) return [];
				const { api } = authed.data;
				return Promise.all(
					ids.map(async (id) => {
						const before = await api.getDevice(id);
						const reason = before.success && before.data.status === "stopped" ? before.data.stopReason : undefined;
						return { id, reason, result: await api.stopDevice(id) };
					})
				);
			})
		)
	).flat();
	const stopReasons: Record<string, StopReason> = {};
	for (const r of results) if (r.reason) stopReasons[r.id] = r.reason;
	return {
		stopped: results.flatMap((r) => (r.result.success ? [r.id] : [])),
		notes: [
			...authNotes,
			...results.flatMap((r) => [
				...(r.reason
					? [`remote device ${r.id} had stopped (stop_reason: ${r.reason}): ${describeStopReason(r.reason)}`]
					: []),
				...(r.result.success ? [] : [`remote device ${r.id}: ${r.result.error.message}`]),
			]),
		],
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
	const groups = byClient(ctx, leases);
	const results = (
		await Promise.all(
			groups.map(async ({ ids, authed }) =>
				authed.success
					? Promise.all(ids.map(async (id) => ({ id, r: await authed.data.api.heartbeatDevice(id) })))
					: ids.map((id) => ({ id, r: { success: false as const, error: { message: authed.error } } }))
			)
		)
	).flat();
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
	const lookups = Promise.all(
		byClient(ctx, leases).map(async ({ ids, authed }) =>
			authed.success ? Promise.all(ids.map(async (id) => ({ id, r: await authed.data.api.getDevice(id) }))) : []
		)
	).then((groups) => groups.flat());
	const timeout = new Promise<[]>((done) => setTimeout(() => done([]), timeoutMs).unref?.());
	const results = await Promise.race([lookups, timeout]);
	const reasons: Record<string, StopReason> = {};
	for (const { id, r } of results) {
		if (r.success && r.data.status === "stopped" && r.data.stopReason) reasons[id] = r.data.stopReason;
	}
	return reasons;
}
