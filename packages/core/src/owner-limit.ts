import { err, ok, type Result } from "@delacour/warden-types/result";
import { ownerKey } from "./store";
import type { Lease, Owner, Platform, QueueEntry } from "./types";

/** Per-owner limit of separate claims: `all` for a plain number, or one entry per platform. Empty = unlimited. */
export type OwnerLimit = { all?: number; ios?: number; android?: number };

const PLATFORMS: readonly Platform[] = ["ios", "android"];
const isPlatform = (s: string): s is Platform => (PLATFORMS as readonly string[]).includes(s);

const usage = (raw: string, why: string): string =>
	`WARDEN_MAX_PER_OWNER=${raw}: ${why} (use a number >= 1, e.g. 2, or per platform: ios=2,android=1)`;

const parseCount = (text: string): number | undefined =>
	/^\d+$/.test(text) && Number(text) >= 1 ? Number(text) : undefined;

/** `WARDEN_MAX_PER_OWNER`: unset / blank = unlimited, `2` = every platform, `ios=2,android=1` = per platform. */
export function parseOwnerLimit(raw: string | undefined): Result<OwnerLimit> {
	const text = raw?.trim();
	if (text === undefined || text === "") return ok({});
	const plain = parseCount(text);
	if (plain !== undefined) return ok({ all: plain });
	const limit: OwnerLimit = {};
	for (const part of text.split(",")) {
		const [name = "", value = ""] = part.split("=").map((s) => s.trim());
		if (!isPlatform(name)) return err(usage(text, `"${part.trim()}" is not <platform>=<n> with platform ios|android`));
		const n = parseCount(value);
		if (n === undefined) return err(usage(text, `"${part.trim()}" needs a whole number >= 1`));
		if (limit[name] !== undefined) return err(usage(text, `${name} is given twice`));
		limit[name] = n;
	}
	return ok(limit);
}

/** The limit for `platform`, undefined = unlimited. A platform entry beats the plain number. */
export const limitFor = (limit: OwnerLimit, platform: Platform): number | undefined => limit[platform] ?? limit.all;

export type OtherClaims = {
	/** distinct separate claims of the owner on the platform, this claim excluded */
	count: number;
	/** the owner's oldest counted live lease: what to release */
	oldest?: Lease;
};

type Asker = { owner: Owner; platform: Platform; claimId: string; queueId: string };

/** The group a lease or queue row falls in; a row without a claim id (older binary) is its own group. */
const groupOf = (claimId: string | undefined, fallback: string): string => claimId ?? fallback;

function ownLeases(leases: readonly Lease[], ask: Asker): Lease[] {
	const key = ownerKey(ask.owner);
	return leases.filter(
		(l) =>
			l.resource.kind === "device" &&
			l.resource.platform === ask.platform &&
			ownerKey(l.owner) === key &&
			l.claimId !== ask.claimId
	);
}

function ownRows(queue: readonly QueueEntry[], ask: Asker): QueueEntry[] {
	const key = ownerKey(ask.owner);
	return queue.filter(
		(e) => e.platform === ask.platform && ownerKey(e.owner) === key && e.id !== ask.queueId && e.claimId !== ask.claimId
	);
}

/**
 * How many separate claims `owner` already has on `platform`: its live device leases and queued claims,
 * grouped by claim id (a wrapper's legs share one, so a `--count 3` run is one claim). A row without a claim
 * id (written by an older binary) counts as one on its own. The asking claim (`claimId`, `queueId`) is left out.
 * Port and build leases never count. The caller passes live leases only.
 */
export function countOtherClaims(
	input: Asker & { leases: readonly Lease[]; queue: readonly QueueEntry[] }
): OtherClaims {
	const leases = ownLeases(input.leases, input);
	const groups = new Set([
		...leases.map((l) => groupOf(l.claimId, `lease:${l.id}`)),
		...ownRows(input.queue, input).map((e) => groupOf(e.claimId, `queue:${e.id}`)),
	]);
	const oldest = leases.reduce<Lease | undefined>(
		(a, l) => (a === undefined || l.acquiredAt < a.acquiredAt ? l : a),
		undefined
	);
	return oldest ? { count: groups.size, oldest } : { count: groups.size };
}
