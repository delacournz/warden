/**
 * AVDs whose current warden snapshot is missing, so a claim cold-booted them: `warden gc` builds one of
 * them per pass once the AVD is idle (see `android-golden.ts`). Kept in the store's `meta` table so every
 * process sees it; this module imports nothing heavy, because auto-gc reads it on the claim path.
 */
import type { Store } from "../store";

export const ANDROID_SNAPSHOT_PENDING_META_KEY = "android_snapshot_pending";
/** A build that failed is retried after this long (a failing build would otherwise cold-boot the AVD every pass). */
export const ANDROID_SNAPSHOT_RETRY_MS = 6 * 60 * 60_000;

type Pending = Record<string, { failedAt?: number }>;

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

/** A claim cold-booted `avd` for want of a snapshot (a recorded failure keeps its retry time). */
export function markAndroidSnapshotPending(store: Store, avd: string): void {
	if (read(store)[avd] !== undefined) return;
	update(store, (pending) => {
		pending[avd] ??= {};
	});
}

/** `avd` has its current snapshot now (or snapshots are off): nothing to build. */
export function clearAndroidSnapshotPending(store: Store, avd?: string): void {
	update(store, (pending) => {
		for (const name of avd === undefined ? Object.keys(pending) : [avd]) delete pending[name];
	});
}

/** A build of `avd` failed at `now`: try again after `ANDROID_SNAPSHOT_RETRY_MS`. */
export function markAndroidSnapshotFailed(store: Store, avd: string, now: number): void {
	update(store, (pending) => {
		pending[avd] = { failedAt: now };
	});
}

/** AVDs a gc pass should build a snapshot of, oldest first; a recent failure waits out its retry time. */
export function pendingAndroidSnapshots(store: Store, now: number): string[] {
	return Object.entries(read(store))
		.filter(([, entry]) => entry.failedAt === undefined || now - entry.failedAt >= ANDROID_SNAPSHOT_RETRY_MS)
		.map(([avd]) => avd);
}

/** `CI` set (and not 0/false): an ephemeral runner, where a background snapshot build never pays off. */
export function onCi(env: Record<string, string | undefined>): boolean {
	const ci = env.CI?.trim().toLowerCase();
	return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
}

/** A gc pass has a snapshot to build: an AVD a claim cold-booted for want of one. Never under `CI`. */
export function androidSnapshotsDue(store: Store, env: Record<string, string | undefined>, now: number): boolean {
	return !onCi(env) && pendingAndroidSnapshots(store, now).length > 0;
}
