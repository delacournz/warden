/**
 * AVDs whose current warden snapshot is missing, so a claim cold-booted them: `warden gc` builds one of
 * them per pass once the AVD is idle (see `android-golden.ts`). Kept in the store's `meta` table so every
 * process sees it; this module imports nothing heavy, because auto-gc reads it on the claim path.
 */
import type { Store } from "../store";

export const ANDROID_SNAPSHOT_PENDING_META_KEY = "android_snapshot_pending";
/** A build that failed is retried after this long (a failing build would otherwise cold-boot the AVD every pass). */
export const ANDROID_SNAPSHOT_RETRY_MS = 6 * 60 * 60_000;

/** A pending AVD a gc pass found running is left out of auto-gc's due check for this long. */
export const ANDROID_SNAPSHOT_BUSY_MS = 60 * 60_000;
/** After this many load failures in a row, gc stops rebuilding the AVD's snapshot (`golden ensure` still does). */
export const ANDROID_SNAPSHOT_MAX_LOAD_FAILURES = 3;

type Entry = {
	failedAt?: number;
	/** a gc pass last found an instance of the AVD running */
	busyAt?: number;
	/** claims that saw the snapshot fail to load, since its last good load or `golden ensure` */
	loadFailures?: number;
	lastLoadFailureAt?: number;
	/** the snapshot is built: kept only for its load-failure record, not pending */
	built?: true;
};
type Pending = Record<string, Entry>;

function read(store: Store): Pending {
	try {
		const parsed: unknown = JSON.parse(store.getMeta(ANDROID_SNAPSHOT_PENDING_META_KEY) ?? "{}");
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Pending) : {};
	} catch {
		return {};
	}
}

function update(store: Store, change: (pending: Pending) => void): void {
	store.transaction(() => {
		const pending = read(store);
		change(pending);
		if (Object.keys(pending).length === 0) store.deleteMeta(ANDROID_SNAPSHOT_PENDING_META_KEY);
		else store.setMeta(ANDROID_SNAPSHOT_PENDING_META_KEY, JSON.stringify(pending));
	});
}

const isPending = (entry: Entry | undefined): entry is Entry => entry !== undefined && entry.built !== true;
const loadRecord = (entry: Entry | undefined): Entry =>
	entry?.loadFailures !== undefined
		? { loadFailures: entry.loadFailures, lastLoadFailureAt: entry.lastLoadFailureAt }
		: {};

/** A claim cold-booted `avd` for want of a snapshot (a recorded failure keeps its retry time). */
export function markAndroidSnapshotPending(store: Store, avd: string): void {
	if (isPending(read(store)[avd])) return;
	update(store, (pending) => {
		if (!isPending(pending[avd])) pending[avd] = loadRecord(pending[avd]);
	});
}

/**
 * `avd` has its current snapshot now (or snapshots are off, with no `avd`: everything is dropped).
 * A load-failure record stays, so a snapshot that keeps failing to load is not rebuilt forever.
 */
export function clearAndroidSnapshotPending(store: Store, avd?: string): void {
	update(store, (pending) => {
		for (const name of avd === undefined ? Object.keys(pending) : [avd]) {
			const record = avd === undefined ? {} : loadRecord(pending[name]);
			if (record.loadFailures !== undefined) pending[name] = { ...record, built: true };
			else delete pending[name];
		}
	});
}

/** A build of `avd` failed at `now`: try again after `ANDROID_SNAPSHOT_RETRY_MS`. */
export function markAndroidSnapshotFailed(store: Store, avd: string, now: number): void {
	update(store, (pending) => {
		pending[avd] = { ...loadRecord(pending[avd]), failedAt: now };
	});
}

/** A gc pass found `avd` running at `now`: auto-gc leaves it out of its due check for a while. */
export function markAndroidSnapshotBusy(store: Store, avd: string, now: number): void {
	update(store, (pending) => {
		const entry = pending[avd];
		if (isPending(entry)) entry.busyAt = now;
	});
}

/**
 * A claim saw `avd`'s snapshot fail to load at `now` (it has been deleted): pending again. A failure
 * within `ANDROID_SNAPSHOT_RETRY_MS` of the previous one waits out the retry time (`deferred`); from
 * `ANDROID_SNAPSHOT_MAX_LOAD_FAILURES` on, gc no longer builds it.
 */
export function recordAndroidSnapshotLoadFailure(
	store: Store,
	avd: string,
	now: number
): { loadFailures: number; deferred: boolean } {
	let result = { loadFailures: 0, deferred: false };
	update(store, (pending) => {
		const previous = pending[avd];
		const loadFailures = (previous?.loadFailures ?? 0) + 1;
		const last = previous?.lastLoadFailureAt;
		const deferred = last !== undefined && now - last < ANDROID_SNAPSHOT_RETRY_MS;
		pending[avd] = { loadFailures, lastLoadFailureAt: now, ...(deferred ? { failedAt: now } : {}) };
		result = { loadFailures, deferred };
	});
	return result;
}

/** Forget `avd`'s load failures (it is pending again, with no retry wait, if it was pending). */
export function resetAndroidSnapshotLoadFailures(store: Store, avd: string): void {
	const entry = read(store)[avd];
	if (entry?.loadFailures === undefined && entry?.failedAt === undefined) return;
	update(store, (pending) => {
		const current = pending[avd];
		if (current === undefined) return;
		if (!isPending(current)) delete pending[avd];
		else pending[avd] = {};
	});
}

/** A claim launched from `avd`'s snapshot and it loaded: its load-failure count starts over. Cheap when there is none. */
export function androidSnapshotLoaded(store: Store, avd: string): void {
	if (read(store)[avd]?.loadFailures === undefined) return;
	update(store, (pending) => {
		const entry = pending[avd];
		if (entry === undefined) return;
		if (!isPending(entry)) delete pending[avd];
		else {
			delete entry.loadFailures;
			delete entry.lastLoadFailureAt;
		}
	});
}

const givenUp = (entry: Entry) => (entry.loadFailures ?? 0) >= ANDROID_SNAPSHOT_MAX_LOAD_FAILURES;

/** Pending AVDs whose snapshot failed to load too often for gc to rebuild it (`warden golden ensure` does). */
export function androidSnapshotsGivenUp(store: Store): string[] {
	return Object.entries(read(store))
		.filter(([, entry]) => isPending(entry) && givenUp(entry))
		.map(([avd]) => avd);
}

/**
 * AVDs a gc pass should build a snapshot of, oldest first; a recent failure waits out its retry time,
 * and an AVD whose snapshot failed to load `ANDROID_SNAPSHOT_MAX_LOAD_FAILURES` times is left out.
 */
export function pendingAndroidSnapshots(store: Store, now: number): string[] {
	return pendingEntries(store, now).map(([avd]) => avd);
}

function pendingEntries(store: Store, now: number): Array<[string, Entry]> {
	return Object.entries(read(store)).filter(
		([, entry]) =>
			isPending(entry) &&
			!givenUp(entry) &&
			(entry.failedAt === undefined || now - entry.failedAt >= ANDROID_SNAPSHOT_RETRY_MS)
	);
}

/** `CI` set (and not 0/false): an ephemeral runner, where a background snapshot build never pays off. */
export function onCi(env: Record<string, string | undefined>): boolean {
	const ci = env.CI?.trim().toLowerCase();
	return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
}

/**
 * Auto-gc has a snapshot to build: an AVD a claim cold-booted for want of one, unless a gc pass found it
 * running within `ANDROID_SNAPSHOT_BUSY_MS` (gc's own pass still tries it). Never under `CI`.
 */
export function androidSnapshotsDue(store: Store, env: Record<string, string | undefined>, now: number): boolean {
	return (
		!onCi(env) &&
		pendingEntries(store, now).some(([, e]) => e.busyAt === undefined || now - e.busyAt >= ANDROID_SNAPSHOT_BUSY_MS)
	);
}
