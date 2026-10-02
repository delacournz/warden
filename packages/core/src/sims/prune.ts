/**
 * Side-effect half of the sim disk audit (see `audit.ts`): list every sim, audit it against the
 * store, and delete the warden-owned ones the audit marks `delete`.
 *
 * Each delete holds a device lease on the sim (under the store's `BEGIN IMMEDIATE`), so a
 * concurrent `claim` can never be handed a sim that is being deleted; a sim leased since the audit
 * is skipped.
 */
import { type AsyncResult, err, ok } from "@delacour/warden-types/result";
import { type Exec, execError } from "../exec";
import { type GoldenSim, parseAllSims } from "../golden/golden";
import type { PidAlive } from "../liveness";
import type { Store } from "../store";
import type { DeviceResource, Lease, Owner } from "../types";
import { auditSims, type SimAudit, type SimAuditEntry } from "./audit";

export type SimsDeps = {
	exec: Exec;
	store: Store;
	owner: Owner;
	/** pid recorded on the delete lease */
	pid: number;
	now: () => number;
	pidAlive: PidAlive;
};

export type SimsAuditOpts = { idleMs: number; maxBytes?: number };
export type SimsPruneOpts = SimsAuditOpts & { dryRun: boolean };

export type SimsPruneResult = {
	audit: SimAudit;
	dryRun: boolean;
	removed: SimAuditEntry[];
	/** leased by someone between the audit and the delete */
	skipped: SimAuditEntry[];
	failed: Array<{ entry: SimAuditEntry; error: string }>;
	freedBytes: number;
};

const DELETE_LEASE_TTL_MS = 5 * 60_000;

async function run(exec: Exec, cmd: string[]): AsyncResult<string> {
	const result = await exec(cmd);
	return result.exitCode === 0 ? ok(result.stdout) : err(execError(cmd, result));
}

/** `du -sk` → bytes; undefined when du fails (e.g. the data dir is gone). */
async function duBytes(exec: Exec, path: string): Promise<number | undefined> {
	const out = await run(exec, ["du", "-sk", path]);
	const kb = out.success ? Number.parseInt(out.data, 10) : Number.NaN;
	return Number.isNaN(kb) ? undefined : kb * 1024;
}

/** Every sim on the machine (all platforms, unavailable included), sized by simctl's `dataPathSize`, else `du`. */
export async function listAllSims(exec: Exec): AsyncResult<GoldenSim[]> {
	const out = await run(exec, ["xcrun", "simctl", "list", "devices", "-j"]);
	if (!out.success) return out;
	const sims = parseAllSims(out.data, { allPlatforms: true });
	if (!sims.success) return sims;
	for (const sim of sims.data) {
		if (sim.dataPathSize !== undefined || sim.dataPath === undefined) continue;
		const bytes = await duBytes(exec, sim.dataPath);
		if (bytes !== undefined) sim.dataPathSize = bytes;
	}
	return sims;
}

function leasedIosIds(store: Store): Set<string> {
	return new Set(
		store
			.listLeases()
			.flatMap((l) => (l.resource.kind === "device" && l.resource.platform === "ios" ? [l.resource.id] : []))
	);
}

export async function auditMachineSims(deps: SimsDeps, opts: SimsAuditOpts): AsyncResult<SimAudit> {
	const sims = await listAllSims(deps.exec);
	if (!sims.success) return sims;
	return ok(
		auditSims({
			sims: sims.data,
			records: deps.store.listDevices("ios"),
			leased: leasedIosIds(deps.store),
			now: deps.now(),
			idleMs: opts.idleMs,
			...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
		})
	);
}

/** Lease the sim for its delete, unless anyone (live or stale) holds it. */
function leaseForDelete(deps: SimsDeps, resource: DeviceResource): Lease | undefined {
	try {
		return deps.store.transaction(() => {
			if (deps.store.findLeaseByResource(resource)) return undefined;
			return deps.store.insertLease(
				{ resource, owner: deps.owner, ttlMs: DELETE_LEASE_TTL_MS, pid: deps.pid, label: "sims prune" },
				deps.now()
			);
		});
	} catch (error) {
		if (error instanceof Error && /UNIQUE constraint/i.test(error.message)) return undefined;
		throw error;
	}
}

export async function pruneSims(deps: SimsDeps, opts: SimsPruneOpts): AsyncResult<SimsPruneResult> {
	const audit = await auditMachineSims(deps, opts);
	if (!audit.success) return audit;
	const candidates = audit.data.entries.filter((e) => e.verdict.kind === "delete" && e.owner === "warden");
	const result: SimsPruneResult = {
		audit: audit.data,
		dryRun: opts.dryRun,
		removed: [],
		skipped: [],
		failed: [],
		freedBytes: 0,
	};
	if (opts.dryRun) {
		result.removed = candidates;
		result.freedBytes = candidates.reduce((s, e) => s + e.bytes, 0);
		return ok(result);
	}
	for (const entry of candidates) {
		const lease = leaseForDelete(deps, { kind: "device", platform: "ios", id: entry.udid, name: entry.name });
		if (!lease) {
			result.skipped.push(entry);
			continue;
		}
		try {
			const deleted = await run(deps.exec, ["xcrun", "simctl", "delete", entry.udid]);
			if (!deleted.success) {
				result.failed.push({ entry, error: deleted.error });
				continue;
			}
			deps.store.forgetDevice("ios", entry.udid);
			result.removed.push(entry);
			result.freedBytes += entry.bytes;
		} finally {
			deps.store.deleteLeases([lease.id]);
		}
	}
	return ok(result);
}
