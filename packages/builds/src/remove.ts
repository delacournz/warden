import { type BuildRecord, BuildsTable } from "@delacour/warden-store/builds-table";
import type { PidAlive } from "@delacour/warden-store/liveness";
import type { Store } from "@delacour/warden-store/store";
import type { Platform } from "@delacour/warden-store/types";
import { type Result, resultFactory } from "@delacour/warden-types/result";
import { buildCache } from "./cache";
import { buildLock } from "./lock";
import { prune } from "./prune";

/** Shortest hash prefix `warden builds rm` takes (`warden builds` shows 12). */
export const MIN_HASH_PREFIX = 6;

export type RemoveInput = {
	store: Store;
	env: Record<string, string | undefined>;
	prefixes: readonly string[];
	platform?: Platform;
	now: number;
	pidAlive: PidAlive;
	dryRun?: boolean;
};

/** What `builds` removed (or would): the build rows, and the install records at their hashes. */
export type RemoveOutcome = { remove: BuildRecord[]; forgotInstalls: number };

/** Removal of named cached builds. Deps arrive per call, so callers share the `remove` instance. */
export class Remove {
	/**
	 * The builds `prefixes` name (each a hash or a unique prefix of at least `MIN_HASH_PREFIX`, `platform`
	 * narrowing it), each with its alias rows. An alias names the build it points at. A prefix matching
	 * nothing or several builds, or a build whose build lock is held, is an error.
	 */
	plan(
		builds: readonly BuildRecord[],
		prefixes: readonly string[],
		platform: Platform | undefined,
		locked: ReadonlySet<string>
	): Result<BuildRecord[]> {
		const primaries: BuildRecord[] = [];
		for (const prefix of prefixes) {
			const only = this.resolvePrefix(builds, prefix, platform, locked);
			if (!only.success) return only;
			if (!primaries.includes(only.data)) primaries.push(only.data);
		}
		return resultFactory.ok(
			primaries.flatMap((p) => [p, ...builds.filter((a) => a !== p && a.path === p.path && prune.isAlias(a))])
		);
	}

	/**
	 * Remove the named builds (files + rows, aliases too) and forget the install records at their hashes, so the
	 * next `ensure` on those devices reinstalls instead of trusting a record whose build is gone.
	 */
	builds(input: RemoveInput): Result<RemoveOutcome> {
		const { store } = input;
		return store.transaction(() => {
			const plan = this.plan(
				new BuildsTable(store).list(),
				input.prefixes,
				input.platform,
				buildLock.live(store, input.now, input.pidAlive)
			);
			if (!plan.success) return plan;
			const dryRun = input.dryRun === true;
			let forgotInstalls = 0;
			for (const platform of new Set(plan.data.map((b) => b.platform))) {
				const hashes = plan.data.filter((b) => b.platform === platform).map((b) => b.hash);
				forgotInstalls += new BuildsTable(store).forgetInstallsAt(platform, hashes, dryRun);
			}
			if (!dryRun) {
				// an alias goes with its primary; an orphan one (its primary already gone) only owns its row
				for (const b of plan.data) {
					if (prune.isAlias(b)) new BuildsTable(store).remove(b.projectKey, b.platform, b.hash);
					else buildCache.remove(store, input.env, b);
				}
			}
			return resultFactory.ok({ remove: plan.data, forgotInstalls });
		});
	}

	private describe(b: BuildRecord): string {
		return `${b.projectKey} ${b.platform} ${b.hash}`;
	}

	/** The build `b` is a row of: itself, or for an alias the primary that owns the files it points at. */
	private primaryOf(builds: readonly BuildRecord[], b: BuildRecord): BuildRecord {
		if (!prune.isAlias(b)) return b;
		return builds.find((p) => p.path === b.path && !prune.isAlias(p)) ?? b;
	}

	private resolvePrefix(
		builds: readonly BuildRecord[],
		prefix: string,
		platform: Platform | undefined,
		locked: ReadonlySet<string>
	): Result<BuildRecord> {
		if (prefix.length < MIN_HASH_PREFIX)
			return resultFactory.err(`hash prefix ${prefix} is too short (at least ${MIN_HASH_PREFIX} characters)`);
		const matched = builds.filter(
			(b) => b.hash.startsWith(prefix) && (platform === undefined || b.platform === platform)
		);
		const found = [...new Set(matched.map((b) => this.primaryOf(builds, b)))];
		const [only, ...rest] = found;
		if (only === undefined) return resultFactory.err(`no cached build matches ${prefix} (see \`warden builds\`)`);
		if (rest.length > 0)
			return resultFactory.err(
				`${prefix} matches ${found.length} builds (${found.map((b) => this.describe(b)).join(", ")}): pass a longer hash or --platform`
			);
		if (locked.has(buildLock.key(only.projectKey, only.platform, only.hash)))
			return resultFactory.err(`${this.describe(only)} is being built or fetched right now`);
		return resultFactory.ok(only);
	}
}

export const remove = new Remove();
