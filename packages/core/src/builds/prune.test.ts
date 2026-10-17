import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store";
import { fakeApp } from "./builds.testing";
import { aliasBuild, type BuildRecord, listBuilds, storeArtifact } from "./cache";
import { buildLockKey, buildResource } from "./lock";
import { formatSize, parseSize, planPrune, pruneBuilds } from "./prune";

const GB = 1024 ** 3;

function rec(hash: string, size: number, lastUsedAt: number): BuildRecord {
	return {
		projectKey: "k",
		platform: "ios",
		profile: "p",
		hash,
		path: `/c/${hash}/A.app`,
		source: "eas",
		size,
		createdAt: 0,
		lastUsedAt,
	};
}

describe("parseSize / formatSize", () => {
	test("units", () => {
		expect(parseSize("20G")).toEqual({ success: true, data: 20 * GB });
		expect(parseSize("500M")).toEqual({ success: true, data: 500 * 1024 ** 2 });
		expect(parseSize("1.5GB")).toEqual({ success: true, data: 1.5 * GB });
		expect(parseSize("2gib")).toEqual({ success: true, data: 2 * GB });
		expect(parseSize("1T")).toEqual({ success: true, data: 1024 ** 4 });
		expect(parseSize("1024")).toEqual({ success: true, data: 1024 });
		expect(parseSize(" 10k ")).toEqual({ success: true, data: 10 * 1024 });
		for (const bad of ["", "G", "-1G", "10X", "ten"]) expect(parseSize(bad).success).toBe(false);
	});

	test("formatSize", () => {
		expect(formatSize(20 * GB)).toBe("20.0G");
		expect(formatSize(1536 * 1024)).toBe("1.5M");
		expect(formatSize(12)).toBe("12B");
	});
});

describe("planPrune", () => {
	const builds = [rec("new", 4 * GB, 300), rec("old", 4 * GB, 100), rec("mid", 4 * GB, 200)];

	test("removes least-recently-used first until under the budget", () => {
		const plan = planPrune(builds, 5 * GB, new Set());
		expect(plan.remove.map((b) => b.hash)).toEqual(["old", "mid"]);
		expect(plan.keep.map((b) => b.hash)).toEqual(["new"]);
		expect(plan.total).toBe(12 * GB);
		expect(plan.after).toBe(4 * GB);
	});

	test("already under budget → nothing", () => {
		expect(planPrune(builds, 20 * GB, new Set()).remove).toEqual([]);
	});

	test("never removes a build whose lock is held", () => {
		const plan = planPrune(builds, 5 * GB, new Set([buildLockKey("k", "ios", "old")]));
		expect(plan.remove.map((b) => b.hash)).toEqual(["mid", "new"]);
		expect(plan.keep.map((b) => b.hash)).toEqual(["old"]);
	});
});

describe("planPrune grace window and aliases (17-11)", () => {
	const MIN = 60_000;
	const builds = [rec("old", 4 * GB, 100), rec("mid", 4 * GB, 200), rec("hot", 4 * GB, 1_000 * MIN)];
	const alias = (hash: string, of: BuildRecord): BuildRecord => ({ ...of, hash, size: 0 });

	test("a build used within the grace window is kept even when the cache is over budget", () => {
		const plan = planPrune(builds, 0, new Set(), { now: 1_010 * MIN, graceMs: 30 * MIN });
		expect(plan.remove.map((b) => b.hash)).toEqual(["old", "mid"]);
		expect(plan.keep.map((b) => b.hash)).toEqual(["hot"]);
		expect(plan.after).toBe(4 * GB);
	});

	test("past the grace window it is an ordinary LRU candidate", () => {
		const plan = planPrune(builds, 0, new Set(), { now: 1_031 * MIN, graceMs: 30 * MIN });
		expect(plan.remove.map((b) => b.hash)).toEqual(["old", "mid", "hot"]);
	});

	test("an alias row is never a candidate of its own; it goes with its primary", () => {
		const old = builds[0] as BuildRecord;
		const mid = builds[1] as BuildRecord;
		const list = [...builds, { ...alias("old-post", old), lastUsedAt: 50 }, alias("mid-post", mid)];
		const plan = planPrune(list, 4 * GB, new Set());
		expect(plan.remove.map((b) => b.hash)).toEqual(["old", "old-post", "mid", "mid-post"]);
		expect(plan.keep.map((b) => b.hash)).toEqual(["hot"]);
		const kept = planPrune(list, 8 * GB, new Set());
		expect(kept.remove.map((b) => b.hash)).toEqual(["old", "old-post"]);
		expect(kept.keep.map((b) => b.hash)).toContain("mid-post");
	});
});

describe("pruneBuilds", () => {
	let dir: string;
	let store: Store;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-prune-"));
		store = openStore(join(dir, "warden.db"));
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("deletes files + records LRU, skipping locked; dry run deletes nothing", async () => {
		const env = { WARDEN_HOME: dir };
		const paths: string[] = [];
		for (const [hash, t] of [
			["a", 1],
			["b", 2],
			["c", 3],
		] as const) {
			const res = await storeArtifact({
				store,
				env,
				projectKey: "k",
				platform: "ios",
				profile: "p",
				hash,
				artifact: fakeApp(join(dir, "src", hash)),
				source: "import",
				now: t,
			});
			if (!res.success) throw new Error(res.error);
			paths.push(res.data.path);
		}
		store.insertLease(
			{ resource: buildResource(buildLockKey("k", "ios", "a")), owner: { kind: "ci", runId: "x" }, ttlMs: 60_000 },
			100
		);
		const dry = pruneBuilds({ store, env, maxBytes: 12, now: 100, pidAlive: () => false, dryRun: true });
		expect(dry.remove.map((b) => b.hash)).toEqual(["b", "c"]);
		expect(listBuilds(store)).toHaveLength(3);

		pruneBuilds({ store, env, maxBytes: 12, now: 100, pidAlive: () => false });
		expect(listBuilds(store).map((b) => b.hash)).toEqual(["a"]);
		expect(paths.map((p) => existsSync(p))).toEqual([true, false, false]);
	});

	test("graceMs keeps a just-used build (an install in flight) and removes an alias with its primary", async () => {
		const env = { WARDEN_HOME: dir };
		const stored = [];
		for (const [hash, t] of [
			["a", 1],
			["b", 80],
		] as const) {
			const res = await storeArtifact({
				store,
				env,
				projectKey: "k",
				platform: "ios",
				profile: "p",
				hash,
				artifact: fakeApp(join(dir, "src", hash)),
				source: "build",
				now: t,
			});
			if (!res.success) throw new Error(res.error);
			stored.push(res.data);
		}
		const [a] = stored;
		if (!a) throw new Error("no build");
		aliasBuild(store, a, "a-post", 1);
		const plan = pruneBuilds({ store, env, maxBytes: 0, now: 100, pidAlive: () => false, graceMs: 50 });
		expect(plan.remove.map((b) => b.hash)).toEqual(["a", "a-post"]);
		expect(listBuilds(store).map((b) => b.hash)).toEqual(["b"]);
	});
});
