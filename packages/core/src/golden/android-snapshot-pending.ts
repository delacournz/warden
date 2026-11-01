/**
 * AVDs whose current warden snapshot is missing, so a claim cold-booted them: `warden gc` builds one of
 * them per pass once the AVD is idle (see `android-golden.ts`). Kept in the store's `meta` table so every
 * process sees it; this module imports nothing heavy, because auto-gc reads it on the claim path.
 */
import type { Store } from "@delacour/warden-store/store";

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

/** Whether the environment is an ephemeral CI runner. Pure, so callers need no store. */
export class CiEnvironment {
	/** `CI` set (and not 0/false): an ephemeral runner, where a background snapshot build never pays off. */
	active(env: Record<string, string | undefined>): boolean {
		const ci = env.CI?.trim().toLowerCase();
		return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
	}
}

export const ciEnvironment = new CiEnvironment();

/** The pending-snapshot book of one store. */
export class AndroidSnapshotPending {
	constructor(private readonly store: Store) {}

	/** A claim cold-booted `avd` for want of a snapshot (a recorded failure keeps its retry time). */
	markPending(avd: string): void {
		if (this.isPending(this.read()[avd])) return;
		this.update((pending) => {
			if (!this.isPending(pending[avd])) pending[avd] = this.loadRecord(pending[avd]);
		});
	}

	/**
	 * `avd` has its current snapshot now (or snapshots are off, with no `avd`: everything is dropped).
	 * A load-failure record stays, so a snapshot that keeps failing to load is not rebuilt forever.
	 */
	clear(avd?: string): void {
		this.update((pending) => {
			for (const name of avd === undefined ? Object.keys(pending) : [avd]) {
				const record = avd === undefined ? {} : this.loadRecord(pending[name]);
				if (record.loadFailures !== undefined) pending[name] = { ...record, built: true };
				else delete pending[name];
			}
		});
	}

	/** A build of `avd` failed at `now`: try again after `ANDROID_SNAPSHOT_RETRY_MS`. */
	markFailed(avd: string, now: number): void {
		this.update((pending) => {
			pending[avd] = { ...this.loadRecord(pending[avd]), failedAt: now };
		});
	}

	/** A gc pass found `avd` running at `now`: auto-gc leaves it out of its due check for a while. */
	markBusy(avd: string, now: number): void {
		this.update((pending) => {
			const entry = pending[avd];
			if (this.isPending(entry)) entry.busyAt = now;
		});
	}

	/**
	 * A claim saw `avd`'s snapshot fail to load at `now` (it has been deleted): pending again. A failure
	 * within `ANDROID_SNAPSHOT_RETRY_MS` of the previous one waits out the retry time (`deferred`); from
	 * `ANDROID_SNAPSHOT_MAX_LOAD_FAILURES` on, gc no longer builds it.
	 */
	recordLoadFailure(avd: string, now: number): { loadFailures: number; deferred: boolean } {
		let result = { loadFailures: 0, deferred: false };
		this.update((pending) => {
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
	resetLoadFailures(avd: string): void {
		const entry = this.read()[avd];
		if (entry?.loadFailures === undefined && entry?.failedAt === undefined) return;
		this.update((pending) => {
			const current = pending[avd];
			if (current === undefined) return;
			if (!this.isPending(current)) delete pending[avd];
			else pending[avd] = {};
		});
	}

	/** A claim launched from `avd`'s snapshot and it loaded: its load-failure count starts over. Cheap when there is none. */
	loaded(avd: string): void {
		if (this.read()[avd]?.loadFailures === undefined) return;
		this.update((pending) => {
			const entry = pending[avd];
			if (entry === undefined) return;
			if (!this.isPending(entry)) delete pending[avd];
			else {
				delete entry.loadFailures;
				delete entry.lastLoadFailureAt;
			}
		});
	}

	/** Pending AVDs whose snapshot failed to load too often for gc to rebuild it (`warden golden ensure` does). */
	givenUp(): string[] {
		return Object.entries(this.read())
			.filter(([, entry]) => this.isPending(entry) && this.exhausted(entry))
			.map(([avd]) => avd);
	}

	/**
	 * AVDs a gc pass should build a snapshot of, oldest first; a recent failure waits out its retry time,
	 * and an AVD whose snapshot failed to load `ANDROID_SNAPSHOT_MAX_LOAD_FAILURES` times is left out.
	 */
	pending(now: number): string[] {
		return this.pendingEntries(now).map(([avd]) => avd);
	}

	/**
	 * Auto-gc has a snapshot to build: an AVD a claim cold-booted for want of one, unless a gc pass found it
	 * running within `ANDROID_SNAPSHOT_BUSY_MS` (gc's own pass still tries it). Never under `CI`.
	 */
	due(env: Record<string, string | undefined>, now: number): boolean {
		return (
			!ciEnvironment.active(env) &&
			this.pendingEntries(now).some(([, e]) => e.busyAt === undefined || now - e.busyAt >= ANDROID_SNAPSHOT_BUSY_MS)
		);
	}

	private read(): Pending {
		try {
			const parsed: unknown = JSON.parse(this.store.getMeta(ANDROID_SNAPSHOT_PENDING_META_KEY) ?? "{}");
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Pending) : {};
		} catch {
			return {};
		}
	}

	private update(change: (pending: Pending) => void): void {
		this.store.transaction(() => {
			const pending = this.read();
			change(pending);
			if (Object.keys(pending).length === 0) this.store.deleteMeta(ANDROID_SNAPSHOT_PENDING_META_KEY);
			else this.store.setMeta(ANDROID_SNAPSHOT_PENDING_META_KEY, JSON.stringify(pending));
		});
	}

	private isPending(entry: Entry | undefined): entry is Entry {
		return entry !== undefined && entry.built !== true;
	}

	private loadRecord(entry: Entry | undefined): Entry {
		return entry?.loadFailures !== undefined
			? { loadFailures: entry.loadFailures, lastLoadFailureAt: entry.lastLoadFailureAt }
			: {};
	}

	private exhausted(entry: Entry): boolean {
		return (entry.loadFailures ?? 0) >= ANDROID_SNAPSHOT_MAX_LOAD_FAILURES;
	}

	private pendingEntries(now: number): Array<[string, Entry]> {
		return Object.entries(this.read()).filter(
			([, entry]) =>
				this.isPending(entry) &&
				!this.exhausted(entry) &&
				(entry.failedAt === undefined || now - entry.failedAt >= ANDROID_SNAPSHOT_RETRY_MS)
		);
	}
}
