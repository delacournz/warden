import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Store, storeLocator } from "@delacour/warden-store/store";
import {
	ANDROID_SNAPSHOT_BUSY_MS,
	ANDROID_SNAPSHOT_MAX_LOAD_FAILURES,
	ANDROID_SNAPSHOT_PENDING_META_KEY,
	ANDROID_SNAPSHOT_RETRY_MS,
	AndroidSnapshotPending,
} from "./android-snapshot-pending";

let dir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-android-pending-"));
	store = storeLocator.open(join(dir, "warden.db"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

const T = 1_000_000;

describe("load failures (S2)", () => {
	test("the first is due at once, a second within the retry window waits it out, the third gives up", () => {
		expect(new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", T)).toEqual({
			loadFailures: 1,
			deferred: false,
		});
		expect(new AndroidSnapshotPending(store).pending(T)).toEqual(["Pixel_10"]);
		new AndroidSnapshotPending(store).clear("Pixel_10");
		expect(new AndroidSnapshotPending(store).pending(T)).toEqual([]);

		const second = T + 60_000;
		expect(new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", second)).toEqual({
			loadFailures: 2,
			deferred: true,
		});
		expect(new AndroidSnapshotPending(store).pending(second + 60_000)).toEqual([]);
		expect(new AndroidSnapshotPending(store).due({}, second + 60_000)).toBe(false);
		expect(new AndroidSnapshotPending(store).pending(second + ANDROID_SNAPSHOT_RETRY_MS)).toEqual(["Pixel_10"]);
		new AndroidSnapshotPending(store).clear("Pixel_10");

		const third = second + ANDROID_SNAPSHOT_RETRY_MS + 60_000;
		expect(new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", third)).toEqual({
			loadFailures: ANDROID_SNAPSHOT_MAX_LOAD_FAILURES,
			deferred: false,
		});
		const later = third + 10 * ANDROID_SNAPSHOT_RETRY_MS;
		expect(new AndroidSnapshotPending(store).pending(later)).toEqual([]);
		expect(new AndroidSnapshotPending(store).due({}, later)).toBe(false);
		expect(new AndroidSnapshotPending(store).givenUp()).toEqual(["Pixel_10"]);
	});

	test("a second failure after the retry window is due at once again", () => {
		new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", T);
		new AndroidSnapshotPending(store).clear("Pixel_10");
		const second = T + ANDROID_SNAPSHOT_RETRY_MS + 1;
		expect(new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", second)).toEqual({
			loadFailures: 2,
			deferred: false,
		});
		expect(new AndroidSnapshotPending(store).pending(second)).toEqual(["Pixel_10"]);
	});

	test("the count survives a build and a failed build; a load or an explicit reset clears it", () => {
		new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", T);
		new AndroidSnapshotPending(store).markFailed("Pixel_10", T);
		new AndroidSnapshotPending(store).clear("Pixel_10");
		expect(new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", T).loadFailures).toBe(2);
		new AndroidSnapshotPending(store).clear("Pixel_10");
		new AndroidSnapshotPending(store).loaded("Pixel_10");
		expect(store.getMeta(ANDROID_SNAPSHOT_PENDING_META_KEY)).toBeUndefined();
		expect(new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", T).loadFailures).toBe(1);
		new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", T);
		new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", T);
		expect(new AndroidSnapshotPending(store).givenUp()).toEqual(["Pixel_10"]);
		new AndroidSnapshotPending(store).resetLoadFailures("Pixel_10");
		expect(new AndroidSnapshotPending(store).givenUp()).toEqual([]);
		// still missing its snapshot: pending, with no backoff left
		expect(new AndroidSnapshotPending(store).pending(T)).toEqual(["Pixel_10"]);
	});

	test("a built AVD with a load-failure record is not pending until a claim finds its snapshot missing", () => {
		new AndroidSnapshotPending(store).recordLoadFailure("Pixel_10", T);
		new AndroidSnapshotPending(store).clear("Pixel_10");
		expect(new AndroidSnapshotPending(store).pending(T)).toEqual([]);
		new AndroidSnapshotPending(store).markPending("Pixel_10");
		expect(new AndroidSnapshotPending(store).pending(T)).toEqual(["Pixel_10"]);
		new AndroidSnapshotPending(store).clear();
		expect(store.getMeta(ANDROID_SNAPSHOT_PENDING_META_KEY)).toBeUndefined();
	});
});

describe("busy AVDs (S5)", () => {
	test("auto-gc skips an AVD a pass found busy within the last hour; gc's own list still has it", () => {
		new AndroidSnapshotPending(store).markPending("Pixel_10");
		new AndroidSnapshotPending(store).markBusy("Pixel_10", T);
		expect(new AndroidSnapshotPending(store).due({}, T + 60_000)).toBe(false);
		expect(new AndroidSnapshotPending(store).pending(T + 60_000)).toEqual(["Pixel_10"]);
		expect(new AndroidSnapshotPending(store).due({}, T + ANDROID_SNAPSHOT_BUSY_MS)).toBe(true);
	});

	test("another pending AVD that is not busy keeps auto-gc due", () => {
		new AndroidSnapshotPending(store).markPending("Pixel_10");
		new AndroidSnapshotPending(store).markPending("Pixel_9");
		new AndroidSnapshotPending(store).markBusy("Pixel_10", T);
		expect(new AndroidSnapshotPending(store).due({}, T)).toBe(true);
	});

	test("a build clears the busy stamp", () => {
		new AndroidSnapshotPending(store).markPending("Pixel_10");
		new AndroidSnapshotPending(store).markBusy("Pixel_10", T);
		new AndroidSnapshotPending(store).clear("Pixel_10");
		new AndroidSnapshotPending(store).markPending("Pixel_10");
		expect(new AndroidSnapshotPending(store).due({}, T)).toBe(true);
	});
});
