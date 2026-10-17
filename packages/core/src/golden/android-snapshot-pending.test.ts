import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store";
import {
	ANDROID_SNAPSHOT_BUSY_MS,
	ANDROID_SNAPSHOT_MAX_LOAD_FAILURES,
	ANDROID_SNAPSHOT_PENDING_META_KEY,
	ANDROID_SNAPSHOT_RETRY_MS,
	androidSnapshotLoaded,
	androidSnapshotsDue,
	androidSnapshotsGivenUp,
	clearAndroidSnapshotPending,
	markAndroidSnapshotBusy,
	markAndroidSnapshotFailed,
	markAndroidSnapshotPending,
	pendingAndroidSnapshots,
	recordAndroidSnapshotLoadFailure,
	resetAndroidSnapshotLoadFailures,
} from "./android-snapshot-pending";

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-android-pending-"));
	store = openStore(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const T = 1_000_000;

describe("load failures (S2)", () => {
	test("the first is due at once, a second within the retry window waits it out, the third gives up", () => {
		expect(recordAndroidSnapshotLoadFailure(store, "Pixel_10", T)).toEqual({ loadFailures: 1, deferred: false });
		expect(pendingAndroidSnapshots(store, T)).toEqual(["Pixel_10"]);
		clearAndroidSnapshotPending(store, "Pixel_10");
		expect(pendingAndroidSnapshots(store, T)).toEqual([]);

		const second = T + 60_000;
		expect(recordAndroidSnapshotLoadFailure(store, "Pixel_10", second)).toEqual({ loadFailures: 2, deferred: true });
		expect(pendingAndroidSnapshots(store, second + 60_000)).toEqual([]);
		expect(androidSnapshotsDue(store, {}, second + 60_000)).toBe(false);
		expect(pendingAndroidSnapshots(store, second + ANDROID_SNAPSHOT_RETRY_MS)).toEqual(["Pixel_10"]);
		clearAndroidSnapshotPending(store, "Pixel_10");

		const third = second + ANDROID_SNAPSHOT_RETRY_MS + 60_000;
		expect(recordAndroidSnapshotLoadFailure(store, "Pixel_10", third)).toEqual({
			loadFailures: ANDROID_SNAPSHOT_MAX_LOAD_FAILURES,
			deferred: false,
		});
		const later = third + 10 * ANDROID_SNAPSHOT_RETRY_MS;
		expect(pendingAndroidSnapshots(store, later)).toEqual([]);
		expect(androidSnapshotsDue(store, {}, later)).toBe(false);
		expect(androidSnapshotsGivenUp(store)).toEqual(["Pixel_10"]);
	});

	test("a second failure after the retry window is due at once again", () => {
		recordAndroidSnapshotLoadFailure(store, "Pixel_10", T);
		clearAndroidSnapshotPending(store, "Pixel_10");
		const second = T + ANDROID_SNAPSHOT_RETRY_MS + 1;
		expect(recordAndroidSnapshotLoadFailure(store, "Pixel_10", second)).toEqual({ loadFailures: 2, deferred: false });
		expect(pendingAndroidSnapshots(store, second)).toEqual(["Pixel_10"]);
	});

	test("the count survives a build and a failed build; a load or an explicit reset clears it", () => {
		recordAndroidSnapshotLoadFailure(store, "Pixel_10", T);
		markAndroidSnapshotFailed(store, "Pixel_10", T);
		clearAndroidSnapshotPending(store, "Pixel_10");
		expect(recordAndroidSnapshotLoadFailure(store, "Pixel_10", T).loadFailures).toBe(2);
		clearAndroidSnapshotPending(store, "Pixel_10");
		androidSnapshotLoaded(store, "Pixel_10");
		expect(store.getMeta(ANDROID_SNAPSHOT_PENDING_META_KEY)).toBeUndefined();
		expect(recordAndroidSnapshotLoadFailure(store, "Pixel_10", T).loadFailures).toBe(1);
		recordAndroidSnapshotLoadFailure(store, "Pixel_10", T);
		recordAndroidSnapshotLoadFailure(store, "Pixel_10", T);
		expect(androidSnapshotsGivenUp(store)).toEqual(["Pixel_10"]);
		resetAndroidSnapshotLoadFailures(store, "Pixel_10");
		expect(androidSnapshotsGivenUp(store)).toEqual([]);
		// still missing its snapshot: pending, with no backoff left
		expect(pendingAndroidSnapshots(store, T)).toEqual(["Pixel_10"]);
	});

	test("a built AVD with a load-failure record is not pending until a claim finds its snapshot missing", () => {
		recordAndroidSnapshotLoadFailure(store, "Pixel_10", T);
		clearAndroidSnapshotPending(store, "Pixel_10");
		expect(pendingAndroidSnapshots(store, T)).toEqual([]);
		markAndroidSnapshotPending(store, "Pixel_10");
		expect(pendingAndroidSnapshots(store, T)).toEqual(["Pixel_10"]);
		clearAndroidSnapshotPending(store);
		expect(store.getMeta(ANDROID_SNAPSHOT_PENDING_META_KEY)).toBeUndefined();
	});
});

describe("busy AVDs (S5)", () => {
	test("auto-gc skips an AVD a pass found busy within the last hour; gc's own list still has it", () => {
		markAndroidSnapshotPending(store, "Pixel_10");
		markAndroidSnapshotBusy(store, "Pixel_10", T);
		expect(androidSnapshotsDue(store, {}, T + 60_000)).toBe(false);
		expect(pendingAndroidSnapshots(store, T + 60_000)).toEqual(["Pixel_10"]);
		expect(androidSnapshotsDue(store, {}, T + ANDROID_SNAPSHOT_BUSY_MS)).toBe(true);
	});

	test("another pending AVD that is not busy keeps auto-gc due", () => {
		markAndroidSnapshotPending(store, "Pixel_10");
		markAndroidSnapshotPending(store, "Pixel_9");
		markAndroidSnapshotBusy(store, "Pixel_10", T);
		expect(androidSnapshotsDue(store, {}, T)).toBe(true);
	});

	test("a build clears the busy stamp", () => {
		markAndroidSnapshotPending(store, "Pixel_10");
		markAndroidSnapshotBusy(store, "Pixel_10", T);
		clearAndroidSnapshotPending(store, "Pixel_10");
		markAndroidSnapshotPending(store, "Pixel_10");
		expect(androidSnapshotsDue(store, {}, T)).toBe(true);
	});
});
