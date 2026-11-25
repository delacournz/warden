import { randomUUID } from "node:crypto";
import { CLAIM_ERRORS, type ClaimErrorCode, claimError, parseClaimError } from "@delacour/warden-core/claim-errors";
import { formatDuration } from "@delacour/warden-core/duration";
import type { HostRecord } from "@delacour/warden-core/hosts/registry";
import type { HostLostReason } from "@delacour/warden-core/lease-events";
import { ownerKey } from "@delacour/warden-core/store";
import {
	type HostDeviceResource,
	type Lease,
	type Owner,
	type Platform,
	resourceKey,
} from "@delacour/warden-core/types";
import { err, ok, type Result } from "@delacour/warden-types/result";
import type { CommandContext } from "../context";
import { lookupHost, remoteFailure, wardenJson } from "./remote";

/** How long a lease on the host lives without a renewal: short, so a laptop that vanishes frees the device soon. */
export function remoteTtl(env: Record<string, string | undefined>): string {
	const raw = env.WARDEN_REMOTE_TTL?.trim();
	return raw ? raw : "90s";
}

/** Warn once a hosted Mac's session has this little left. */
export const HOST_EXPIRY_WARN_MS = 10 * 60_000;

const CLAIM_TRIES = 3;

/** The claim flags a host claim passes on as typed; TTL, label and key are set by `claimOnHost`, windows by the host. */
export type HostClaimFlags = {
	profile?: string;
	runtime?: string;
	count?: string;
	max?: string;
	wait?: string | false;
	priority?: string;
};

export function hostClaimArgs(flags: HostClaimFlags): string[] {
	return [
		...(flags.profile !== undefined ? ["--profile", flags.profile] : []),
		...(flags.runtime !== undefined ? ["--runtime", flags.runtime] : []),
		...(flags.count !== undefined && flags.count !== "1" ? ["--count", flags.count] : []),
		...(flags.max !== undefined ? ["--max", flags.max] : []),
		...(flags.wait === false ? ["--no-wait"] : flags.wait !== undefined ? ["--wait", flags.wait] : []),
		...(flags.priority !== undefined ? ["--priority", flags.priority] : []),
	];
}
const RETRY_DELAY_MS = 2000;

export type HostLease = Lease & { resource: HostDeviceResource };

export function hostLeases(leases: readonly Lease[]): HostLease[] {
	return leases.filter((l): l is HostLease => l.resource.kind === "host-device");
}

export type HostClaimInput = {
	host: string;
	platform: Platform;
	owner: Owner;
	ttlMs: number;
	label?: string;
	idempotencyKey?: string;
	pid?: number;
	/** claim flags passed on as typed (`--profile x`, `--count 2`, `--wait 5m`) */
	remoteArgs: readonly string[];
	/** each line the host prints while it waits (queue, boot); its JSON answer is held back */
	onWait?: (line: string) => void;
};

export type HostClaimDeps = { uuid?: () => string; retryDelayMs?: number; sleep?: (ms: number) => Promise<void> };

export type HostClaimed = { lease: HostLease; action: string };

type RemoteClaimed = { leaseId: string; platform: Platform; udid: string; name: string; action: string };

function isPlatform(v: unknown): v is Platform {
	return v === "ios" || v === "android";
}

function parseClaimed(json: unknown): RemoteClaimed[] | undefined {
	const leases: unknown = typeof json === "object" && json !== null ? Reflect.get(json, "leases") : undefined;
	if (!Array.isArray(leases)) return undefined;
	const out: RemoteClaimed[] = [];
	for (const l of leases) {
		if (typeof l !== "object" || l === null) return undefined;
		const leaseId: unknown = Reflect.get(l, "leaseId");
		const platform: unknown = Reflect.get(l, "platform");
		const udid: unknown = Reflect.get(l, "udid");
		const name: unknown = Reflect.get(l, "name");
		const action: unknown = Reflect.get(l, "action");
		if (typeof leaseId !== "string" || typeof udid !== "string" || !isPlatform(platform)) return undefined;
		out.push({
			leaseId,
			platform,
			udid,
			name: typeof name === "string" ? name : udid,
			action: typeof action === "string" ? action : "reuse",
		});
	}
	return out;
}

const isClaimCode = (s: string): s is ClaimErrorCode => Object.hasOwn(CLAIM_ERRORS, s);

/** The host's `--json` failure as a local claim error: a coded one keeps its code (so its exit), prefixed with the host. */
function hostClaimFailure(host: string, json: unknown, exitCode: number): string {
	const failure = remoteFailure(json);
	const message = `${host}: ${failure?.message ?? `warden claim exited ${exitCode}`}`;
	const code = failure?.code;
	if (code === undefined || !isClaimCode(code)) return message;
	if (code !== "NO_CAPACITY") return claimError({ code }, message);
	const error: unknown = typeof json === "object" && json !== null ? Reflect.get(json, "error") : undefined;
	const reason: unknown =
		typeof error === "object" && error !== null ? Reflect.get(error, "capacityReason") : undefined;
	const tagged = `${code}[${String(reason)}]: ${message}`;
	return parseClaimError(tagged) ? tagged : message;
}

/** Hold back a `--json` answer's lines (pretty-printed or not); pass the rest on. */
function waitLines(onWait: ((line: string) => void) | undefined): ((line: string) => void) | undefined {
	if (!onWait) return undefined;
	let inJson = false;
	return (line) => {
		if (line.startsWith("{")) inJson = true;
		if (!inJson && line.trim() !== "") onWait(line);
		if (line === "}") inJson = false;
	};
}

/** The local lease TTL: the caller's, capped by when a hosted Mac's session ends. */
function localTtl(host: HostRecord, ttlMs: number, now: number): number {
	return host.expiresAt === undefined ? ttlMs : Math.min(ttlMs, host.expiresAt - now);
}

/** The host's claim, tried again (same argv, so the same key) while the host can't be reached. */
async function claimWithRetries(
	ctx: CommandContext,
	host: HostRecord,
	args: readonly string[],
	input: HostClaimInput,
	deps: HostClaimDeps
): ReturnType<typeof wardenJson> {
	const sleep = deps.sleep ?? ctx.sleep ?? ((ms: number) => Bun.sleep(ms));
	const onLine = waitLines(input.onWait);
	for (let attempt = 1; ; attempt++) {
		const ran = await wardenJson(ctx, host, args, { timeoutMs: 30 * 60_000, ...(onLine ? { onLine } : {}) });
		if (ran.success || !ran.error.startsWith("HOST_UNREACHABLE:") || attempt >= CLAIM_TRIES) return ran;
		await sleep(deps.retryDelayMs ?? RETRY_DELAY_MS);
	}
}

/**
 * `warden claim <platform> --host <name>`: the host's warden claims (`--json`, an idempotency key, a short
 * `--ttl` the keepalive renews), then each device it leased is recorded here as a `host-device` lease owned by
 * the caller. An unreachable host is retried with the same key, so a claim that landed before the link dropped
 * is handed back, not claimed twice.
 */
export async function claimOnHost(
	ctx: CommandContext,
	input: HostClaimInput,
	deps: HostClaimDeps = {}
): Promise<Result<{ host: HostRecord; claimed: HostClaimed[] }>> {
	const found = lookupHost(ctx, input.host);
	if (!found.success) return found;
	const host = found.data;
	if (host.expiresAt !== undefined && host.expiresAt <= ctx.now()) {
		return err(`${host.name}: the hosted Mac's session ended; renew it or add another host`);
	}
	const key = input.idempotencyKey ?? (deps.uuid ?? randomUUID)();
	const args = [
		"claim",
		input.platform,
		"--json",
		"--idempotency-key",
		key,
		"--ttl",
		remoteTtl(ctx.env),
		...(input.label !== undefined ? ["--label", input.label] : []),
		...input.remoteArgs,
	];
	const ran = await claimWithRetries(ctx, host, args, input, deps);
	if (!ran.success) return ran;
	const { exitCode, json } = ran.data;
	const remote = exitCode === 0 ? parseClaimed(json) : undefined;
	if (remote === undefined) return err(hostClaimFailure(host.name, json, exitCode));
	return ok({ host, claimed: recordClaimed(ctx, host, input, remote) });
}

function recordClaimed(
	ctx: CommandContext,
	host: HostRecord,
	input: HostClaimInput,
	remote: readonly RemoteClaimed[]
): HostClaimed[] {
	const store = ctx.store();
	const now = ctx.now();
	const ttlMs = localTtl(host, input.ttlMs, now);
	return store.transaction(() =>
		remote.map((r) => {
			const resource: HostDeviceResource = {
				kind: "host-device",
				host: host.name,
				remoteLeaseId: r.leaseId,
				platform: r.platform,
				id: r.udid,
				name: r.name,
				...(host.expiresAt !== undefined ? { expiresAt: host.expiresAt } : {}),
			};
			const lease = store.insertLease(
				{
					resource,
					owner: input.owner,
					ttlMs,
					...(input.label !== undefined ? { label: input.label } : {}),
					...(input.pid !== undefined ? { pid: input.pid } : {}),
				},
				now
			);
			store.recordEvent({
				at: now,
				type: "host_claimed",
				data: { host: host.name, platform: r.platform, remoteLeaseId: r.leaseId, deviceId: r.udid, deviceName: r.name },
				leaseId: lease.id,
				resourceKey: resourceKey(resource),
				ownerKey: ownerKey(input.owner),
				...(input.label !== undefined ? { label: input.label } : {}),
			});
			return { lease: { ...lease, resource }, action: r.action };
		})
	);
}

/** Host leases grouped by host name, in first-seen order. */
function byHost(leases: readonly HostLease[]): Map<string, HostLease[]> {
	const groups = new Map<string, HostLease[]>();
	for (const l of leases) groups.set(l.resource.host, [...(groups.get(l.resource.host) ?? []), l]);
	for (const group of groups.values())
		group.sort((a, b) => a.resource.remoteLeaseId.localeCompare(b.resource.remoteLeaseId));
	return groups;
}

function stringList(json: unknown, key: string): string[] {
	const v: unknown = typeof json === "object" && json !== null ? Reflect.get(json, key) : undefined;
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function expiryNote(lease: HostLease, now: number): string | undefined {
	const at = lease.resource.expiresAt;
	if (at === undefined || at - now > HOST_EXPIRY_WARN_MS) return undefined;
	return `${lease.resource.host}'s session ends in ${formatDuration(Math.max(0, at - now))}: the lease ends with it (host_expired)`;
}

export type HostBeat = {
	notes: string[];
	/** leases the host no longer holds (its gc expired them, or someone released them there) */
	gone: HostLease[];
	/** hosts that could not be reached (or are no longer registered) */
	failed: string[];
};

/**
 * Renew the host leases behind `leases` (others skipped): one `warden heartbeat <ids> --json` per host. A host that
 * can't be reached is a note (the keepalive counts those); an id the host no longer knows is `gone`.
 */
export async function heartbeatHostLeases(ctx: CommandContext, leases: readonly Lease[]): Promise<HostBeat> {
	const notes: string[] = [];
	const gone: HostLease[] = [];
	const failed: string[] = [];
	const now = ctx.now();
	for (const [name, group] of byHost(hostLeases(leases))) {
		const expiring = group.map((l) => expiryNote(l, now)).find((n) => n !== undefined);
		if (expiring) notes.push(expiring);
		const host = lookupHost(ctx, name);
		const ran = host.success
			? await wardenJson(ctx, host.data, ["heartbeat", ...group.map((l) => l.resource.remoteLeaseId), "--json"], {
					timeoutMs: 30_000,
				})
			: host;
		if (!ran.success) {
			notes.push(ran.error);
			failed.push(name);
			continue;
		}
		const unknown = new Set(stringList(ran.data.json, "unknown"));
		gone.push(...group.filter((l) => unknown.has(l.resource.remoteLeaseId)));
	}
	return { notes, gone, failed };
}

export type HostRelease = { released: string[]; notes: string[] };

/** Release the host leases behind `leases` there: `warden release <ids> --json [--shutdown]` per host; never fatal. */
export async function releaseHostLeases(
	ctx: CommandContext,
	leases: readonly Lease[],
	opts: { shutdown?: boolean }
): Promise<HostRelease> {
	const released: string[] = [];
	const notes: string[] = [];
	for (const [name, group] of byHost(hostLeases(leases))) {
		const ids = group.map((l) => l.resource.remoteLeaseId);
		const host = lookupHost(ctx, name);
		const ran = host.success
			? await wardenJson(ctx, host.data, ["release", ...ids, "--json", ...(opts.shutdown ? ["--shutdown"] : [])], {
					timeoutMs: 60_000,
				})
			: host;
		if (!ran.success) {
			notes.push(`${ran.error} (released here; the host lease expires there on its own)`);
			continue;
		}
		released.push(...stringList(ran.data.json, "released"));
	}
	return { released, notes };
}

/** Drop host leases here that ended without a release, each with a `host_lost` event saying why. */
export function loseHostLeases(ctx: CommandContext, leases: readonly HostLease[], reason: HostLostReason): void {
	const store = ctx.store();
	const now = ctx.now();
	store.transaction(() => {
		for (const l of leases) {
			if (store.deleteLeases([l.id]) === 0) continue;
			store.recordEvent({
				at: now,
				type: "host_lost",
				data: { host: l.resource.host, remoteLeaseId: l.resource.remoteLeaseId, reason },
				leaseId: l.id,
				resourceKey: resourceKey(l.resource),
				ownerKey: ownerKey(l.owner),
				...(l.label !== undefined ? { label: l.label } : {}),
			});
		}
	});
}
