import { liveness, type PidAlive } from "@delacour/warden-store/liveness";
import type { Store } from "@delacour/warden-store/store";
import { type BuildResource, type Lease, leaseModel, type Owner, type Platform } from "@delacour/warden-store/types";
import { type AsyncResult, resultFactory } from "@delacour/warden-types/result";
import { BUILD_LOCK_POLL_MS, BUILD_LOCK_TTL_MS, BUILD_LOCK_WAIT_MS } from "./builds.defaults";

export type BuildLockDeps = {
	store: Store;
	owner: Owner;
	/** pid recorded on the lock — the lock lives while this process does */
	pid: number;
	now: () => number;
	pidAlive: PidAlive;
	sleep: (ms: number) => Promise<void>;
	log?: (line: string) => void;
	/** the one line logged when this starts waiting, given the holder (default: "another warden (…) is fetching/building this app — waiting") */
	waitLine?: (holder: string) => string;
	/** called with the holder's lease on every poll while another owner holds the lock (progress, log tailing) */
	onWait?: (held: Lease) => void;
	pollMs?: number;
	waitMs?: number;
	ttlMs?: number;
};

type Attempt = { kind: "acquired"; lease: Lease } | { kind: "held"; lease: Lease };

/** Build-lock leases: keys, resources and the poll-until-free runner. Deps arrive per call, so callers share one instance. */
export class BuildLock {
	/** Lease key serialising work on one (project, platform, fingerprint). */
	key(projectKey: string, platform: Platform, hash: string): string {
		return `${projectKey}|${platform}|${hash}`;
	}

	/**
	 * Lease key serialising local builds in one checkout: a build writes the working tree (prebuild, Pods, build/), so two
	 * builds of any fingerprints in one `root` clobber each other, and a fingerprint read while one runs is of a half-written
	 * native dir. `root` should be a realpath, so two spellings of one checkout share it.
	 */
	treeKey(root: string, platform: Platform): string {
		return `tree:${root}|${platform}`;
	}

	resource(key: string): BuildResource {
		return { kind: "build", key };
	}

	/**
	 * Run `fn` holding the build lease for `key`. While another live owner holds it, poll (up to
	 * `waitMs`); callers re-check the cache inside `fn`, so a waiter ends up with the holder's result
	 * instead of downloading/building again. The lease is always released.
	 */
	async hold<T>(deps: BuildLockDeps, key: string, fn: () => AsyncResult<T>): AsyncResult<T> {
		const resource = this.resource(key);
		const started = deps.now();
		const waitMs = deps.waitMs ?? BUILD_LOCK_WAIT_MS;
		let announced = false;
		for (;;) {
			const got = this.attempt(deps, resource);
			if (got?.kind === "acquired") {
				try {
					return await fn();
				} finally {
					deps.store.deleteLeases([got.lease.id]);
				}
			}
			if (deps.now() - started >= waitMs) {
				return resultFactory.err(
					`timed out waiting for build lock ${key}${got ? ` (held by ${leaseModel.describeOwner(got.lease.owner)})` : ""}`
				);
			}
			if (got) {
				this.noticeHolder(deps, got.lease, !announced);
				announced = true;
			}
			await deps.sleep(deps.pollMs ?? BUILD_LOCK_POLL_MS);
		}
	}

	/** Keys of build leases currently alive (prune never deletes these). */
	live(store: Store, now: number, pidAlive: PidAlive): Set<string> {
		return new Set(
			store
				.listLeases()
				.filter((l) => liveness.isLeaseAlive(l, now, pidAlive))
				.flatMap((l) => (l.resource.kind === "build" ? [l.resource.key] : []))
		);
	}

	private isUniqueViolation(error: unknown): boolean {
		return error instanceof Error && /UNIQUE constraint/i.test(error.message);
	}

	private attempt(deps: BuildLockDeps, resource: BuildResource): Attempt | undefined {
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
			if (this.isUniqueViolation(error)) return undefined;
			throw error;
		}
	}

	/** One poll while another owner holds the lock: the wait line the first time, `onWait` every time. */
	private noticeHolder(deps: BuildLockDeps, held: Lease, first: boolean): void {
		if (first) {
			const holder = leaseModel.describeOwner(held.owner);
			deps.log?.(deps.waitLine?.(holder) ?? `another warden (${holder}) is fetching/building this app — waiting`);
		}
		deps.onWait?.(held);
	}
}

export const buildLock = new BuildLock();
