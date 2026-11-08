import { err, ok, type Result } from "@delacour/warden-types/result";
import type { PidAlive } from "../liveness";
import type { Store } from "../store";
import type { Platform } from "../types";
import { type BuildRecord, deleteBuildRecord, forgetInstallsAt, listBuilds, removeBuild } from "./cache";
import { buildLockKey, liveBuildLocks } from "./lock";
import { isAlias } from "./prune";

/** Shortest hash prefix `warden builds rm` takes (`warden builds` shows 12). */
export const MIN_HASH_PREFIX = 6;

const describe = (b: BuildRecord) => `${b.projectKey} ${b.platform} ${b.hash}`;

/** The build `b` is a row of: itself, or for an alias the primary that owns the files it points at. */
function primaryOf(builds: readonly BuildRecord[], b: BuildRecord): BuildRecord {
	if (!isAlias(b)) return b;
	return builds.find((p) => p.path === b.path && !isAlias(p)) ?? b;
}

/**
 * The builds `prefixes` name (each a hash or a unique prefix of at least `MIN_HASH_PREFIX`, `platform`
 * narrowing it), each with its alias rows. An alias names the build it points at. A prefix matching
 * nothing or several builds, or a build whose build lock is held, is an error.
 */
export function planRemove(
	builds: readonly BuildRecord[],
	prefixes: readonly string[],
	platform: Platform | undefined,
	locked: ReadonlySet<string>
): Result<BuildRecord[]> {
	const primaries: BuildRecord[] = [];
	for (const prefix of prefixes) {
		if (prefix.length < MIN_HASH_PREFIX)
			return err(`hash prefix ${prefix} is too short (at least ${MIN_HASH_PREFIX} characters)`);
		const matched = builds.filter(
			(b) => b.hash.startsWith(prefix) && (platform === undefined || b.platform === platform)
		);
		const found = [...new Set(matched.map((b) => primaryOf(builds, b)))];
		const [only, ...rest] = found;
		if (only === undefined) return err(`no cached build matches ${prefix} (see \`warden builds\`)`);
		if (rest.length > 0)
			return err(
				`${prefix} matches ${found.length} builds (${found.map(describe).join(", ")}): pass a longer hash or --platform`
			);
		if (locked.has(buildLockKey(only.projectKey, only.platform, only.hash)))
			return err(`${describe(only)} is being built or fetched right now`);
		if (!primaries.includes(only)) primaries.push(only);
	}
	return ok(primaries.flatMap((p) => [p, ...builds.filter((a) => a !== p && a.path === p.path && isAlias(a))]));
}

export type RemoveInput = {
	store: Store;
	env: Record<string, string | undefined>;
	prefixes: readonly string[];
	platform?: Platform;
	now: number;
	pidAlive: PidAlive;
	dryRun?: boolean;
};

/** What `removeBuilds` removed (or would): the build rows, and the install records at their hashes. */
export type RemoveOutcome = { remove: BuildRecord[]; forgotInstalls: number };

/**
 * Remove the named builds (files + rows, aliases too) and forget the install records at their hashes, so the
 * next `ensure` on those devices reinstalls instead of trusting a record whose build is gone.
 */
export function removeBuilds(input: RemoveInput): Result<RemoveOutcome> {
	const { store } = input;
	return store.transaction(() => {
		const plan = planRemove(
			listBuilds(store),
			input.prefixes,
			input.platform,
			liveBuildLocks(store, input.now, input.pidAlive)
		);
		if (!plan.success) return plan;
		const dryRun = input.dryRun === true;
		let forgotInstalls = 0;
		for (const platform of new Set(plan.data.map((b) => b.platform))) {
			const hashes = plan.data.filter((b) => b.platform === platform).map((b) => b.hash);
			forgotInstalls += forgetInstallsAt(store, platform, hashes, dryRun);
		}
		if (!dryRun) {
			// an alias goes with its primary; an orphan one (its primary already gone) only owns its row
			for (const b of plan.data) {
				if (isAlias(b)) deleteBuildRecord(store, b.projectKey, b.platform, b.hash);
				else removeBuild(store, input.env, b);
			}
		}
		return ok({ remove: plan.data, forgotInstalls });
	});
}
