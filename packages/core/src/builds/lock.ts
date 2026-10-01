import { type AsyncResult, err } from "@delacour/warden-types/result";
import { isLeaseAlive, type PidAlive } from "../liveness";
import type { Store } from "../store";
import { type BuildResource, describeOwner, type Lease, type Owner, type Platform } from "../types";
import { BUILD_LOCK_POLL_MS, BUILD_LOCK_TTL_MS, BUILD_LOCK_WAIT_MS } from "./builds.defaults";

/** Lease key serialising work on one (project, platform, fingerprint). */
export function buildLockKey(projectKey: string, platform: Platform, hash: string): string {
	return `${projectKey}|${platform}|${hash}`;
}

export function buildResource(key: string): BuildResource {
	return { kind: "build", key };
}

export type BuildLockDeps = {
	store: Store;
	owner: Owner;
	/** pid recorded on the lock — the lock lives while this process does */
	pid: number;
	now: () => number;
	pidAlive: PidAlive;
	sleep: (ms: number) => Promise<void>;
	log?: (line: string) => void;
	pollMs?: number;
	waitMs?: number;
	ttlMs?: number;
};

type Attempt = { kind: "acquired"; lease: Lease } | { kind: "held"; lease: Lease };

function isUniqueViolation(error: unknown): boolean {
	return error instanceof Error && /UNIQUE constraint/i.test(error.message);
}

function attempt(deps: BuildLockDeps, resource: BuildResource): Attempt | undefined {
	try {
		return deps.store.transaction((): Attempt => {
			const now = deps.now();
			deps.store.reclaimStale(now, deps.pidAlive);
			const held = deps.store.findLeaseByResource(resource);
			if (held) return { kind: "held", lease: held };
			const lease = deps.store.insertLease(
				{ resource, owner: deps.owner, ttlMs: deps.ttlMs ?? BUILD_LOCK_TTL_MS, pid: deps.pid, label: "build" },
				now
			);
			return { kind: "acquired", lease };
		});
	} catch (error) {
		if (isUniqueViolation(error)) return undefined;
		throw error;
	}
}

/**
 * Run `fn` holding the build lease for `key`. While another live owner holds it, poll (up to
 * `waitMs`); callers re-check the cache inside `fn`, so a waiter ends up with the holder's result
 * instead of downloading/building again. The lease is always released.
 */
export async function withBuildLock<T>(deps: BuildLockDeps, key: string, fn: () => AsyncResult<T>): AsyncResult<T> {
	const resource = buildResource(key);
	const started = deps.now();
	const waitMs = deps.waitMs ?? BUILD_LOCK_WAIT_MS;
	let announced = false;
	for (;;) {
		const got = attempt(deps, resource);
		if (got?.kind === "acquired") {
			try {
				return await fn();
			} finally {
				deps.store.deleteLeases([got.lease.id]);
			}
		}
		if (deps.now() - started >= waitMs) {
			return err(`timed out waiting for build lock ${key}${got ? ` (held by ${describeOwner(got.lease.owner)})` : ""}`);
		}
		if (got && !announced) {
			deps.log?.(`another warden (${describeOwner(got.lease.owner)}) is fetching/building this app — waiting`);
			announced = true;
		}
		await deps.sleep(deps.pollMs ?? BUILD_LOCK_POLL_MS);
	}
}

/** Keys of build leases currently alive (prune never deletes these). */
export function liveBuildLocks(store: Store, now: number, pidAlive: PidAlive): Set<string> {
	return new Set(
		store
			.listLeases()
			.filter((l) => isLeaseAlive(l, now, pidAlive))
			.flatMap((l) => (l.resource.kind === "build" ? [l.resource.key] : []))
	);
}
