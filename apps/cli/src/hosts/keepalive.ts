import { isLeaseAlive, type PidAlive, processAlive } from "@delacour/warden-core/liveness";
import type { Store } from "@delacour/warden-core/store";
import { backgroundAllowed, selfCommand, spawnDetached } from "../autogc";
import type { CommandContext } from "../context";
import { type HostLease, heartbeatHostLeases, hostLeases, loseHostLeases, releaseHostLeases } from "./claim";

/**
 * The keepalive: one detached `warden __host-keepalive --host <name>` per host renews the host's short leases
 * while the local ones live, and ends the local ones the host can no longer back.
 */

/** store meta key (`+ <host>`) holding the pid of the host's keepalive */
export const KEEPALIVE_META = "host-keepalive:";
export const KEEPALIVE_INTERVAL_MS = 30_000;
/** unreachable beats in a row before the leases are given up (≈ the host's 90 s TTL) */
export const KEEPALIVE_MAX_FAILURES = 3;

export type KeepaliveState = { done: boolean; failures: number };

function leasesOn(ctx: CommandContext, host: string): HostLease[] {
	return hostLeases(ctx.store().listLeases()).filter((l) => l.resource.host === host);
}

/**
 * One beat for `host`: release (there and here) the leases whose local holder went away, end every lease once a
 * hosted Mac's session is over (`host_expired`), renew the rest, drop the ones the host no longer holds
 * (`remote_gone`), and after `KEEPALIVE_MAX_FAILURES` unreachable beats in a row, drop them all (`unreachable`).
 * `done` = nothing left to keep alive.
 */
export async function keepaliveTick(
	ctx: CommandContext,
	host: string,
	failures: number,
	pidAlive: PidAlive = processAlive
): Promise<KeepaliveState> {
	const now = ctx.now();
	const all = leasesOn(ctx, host);
	const expired = all.filter((l) => l.resource.expiresAt !== undefined && l.resource.expiresAt <= now);
	if (expired.length > 0) {
		await releaseHostLeases(ctx, expired, {});
		loseHostLeases(ctx, expired, "host_expired");
	}
	const live = all.filter((l) => !expired.includes(l));
	const stale = live.filter((l) => !isLeaseAlive(l, now, pidAlive));
	if (stale.length > 0) {
		await releaseHostLeases(ctx, stale, {});
		ctx.store().deleteLeases(
			stale.map((l) => l.id),
			{ type: "expired", now }
		);
	}
	const held = live.filter((l) => !stale.includes(l));
	if (held.length === 0) return { done: true, failures: 0 };
	const beat = await heartbeatHostLeases(ctx, held);
	if (beat.failed.includes(host)) {
		if (failures + 1 < KEEPALIVE_MAX_FAILURES) return { done: false, failures: failures + 1 };
		loseHostLeases(ctx, held, "unreachable");
		return { done: true, failures: failures + 1 };
	}
	if (beat.gone.length > 0) loseHostLeases(ctx, beat.gone, "remote_gone");
	return { done: held.length === beat.gone.length, failures: 0 };
}

/** Start a keepalive for `host` unless a live one already holds its row (or background work is off). */
export function shouldStartKeepalive(
	store: Store,
	env: Record<string, string | undefined>,
	host: string,
	pidAlive: PidAlive = processAlive
): boolean {
	if (!backgroundAllowed(env)) return false;
	const pid = Number(store.getMeta(`${KEEPALIVE_META}${host}`) ?? 0);
	return !(pid > 0 && pidAlive(pid));
}

/** Spawn the host's keepalive when none is running. */
export function ensureKeepalive(ctx: CommandContext, host: string): void {
	if (!shouldStartKeepalive(ctx.store(), ctx.env, host)) return;
	spawnDetached([...selfCommand(), "__host-keepalive", "--host", host], { ...process.env, ...ctx.env });
}

export type KeepaliveDeps = { sleep?: (ms: number) => Promise<void>; pid?: number; pidAlive?: PidAlive };

/**
 * The `__host-keepalive` loop: take the host's row (a live other keepalive wins), beat every 30 s until nothing is
 * left, then give the row back.
 */
export async function runKeepalive(ctx: CommandContext, host: string, deps: KeepaliveDeps = {}): Promise<number> {
	const store = ctx.store();
	const key = `${KEEPALIVE_META}${host}`;
	const me = deps.pid ?? process.pid;
	const pidAlive = deps.pidAlive ?? processAlive;
	const took = store.transaction(() => {
		const pid = Number(store.getMeta(key) ?? 0);
		if (pid > 0 && pid !== me && pidAlive(pid)) return false;
		store.setMeta(key, String(me));
		return true;
	});
	if (!took) return 0;
	const sleep = deps.sleep ?? ctx.sleep ?? ((ms: number) => Bun.sleep(ms));
	let state: KeepaliveState = { done: false, failures: 0 };
	try {
		while (!state.done) {
			state = await keepaliveTick(ctx, host, state.failures, pidAlive);
			if (!state.done) await sleep(KEEPALIVE_INTERVAL_MS);
		}
	} finally {
		store.transaction(() => {
			if (store.getMeta(key) === String(me)) store.deleteMeta(key);
		});
	}
	return 0;
}
