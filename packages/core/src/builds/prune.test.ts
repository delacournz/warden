import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@delacour/warden-types/result";
import { openStore, type Store } from "../store";
import { fakeApp } from "./builds.testing";
import { aliasBuild, type BuildRecord, listBuilds, recordRepack, storeArtifact, upsertBuild } from "./cache";
import { buildLockKey, buildResource } from "./lock";
import { cacheCap, formatSize, isAlias, parseSize, planPrune, pruneBuilds } from "./prune";

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

describe("cacheCap (fingerprint-memo-R6)", () => {
	test("the flag, else WARDEN_MAX_CACHE_SIZE, else 20G, with the source of an invalid value", () => {
		expect(cacheCap("1G", { WARDEN_MAX_CACHE_SIZE: "2G" })).toEqual({ source: "flag", bytes: ok(1024 ** 3) });
		expect(cacheCap(undefined, { WARDEN_MAX_CACHE_SIZE: "2G" })).toEqual({ source: "env", bytes: ok(2 * 1024 ** 3) });
		expect(cacheCap(undefined, {})).toEqual({ source: "default", bytes: ok(20 * 1024 ** 3) });
		const bad = cacheCap(undefined, { WARDEN_MAX_CACHE_SIZE: "huge" });
		expect(bad.source).toBe("env");
		expect(bad.bytes.success).toBe(false);
	});
});

describe("planPrune with build kinds", () => {
	const MB = 1024 ** 2;
	const mk = {
		base: (fp: string, size: number, lastUsedAt: number, createdAt = 0): BuildRecord => ({
			...rec(`${fp}:base`, size, lastUsedAt),
			path: `/c/${fp}/simulator/base/A.app`,
			kind: "simulator-base",
			createdAt,
		}),
		repack: (
			fp: string,
			jsKey: string,
			size: number,
			lastUsedAt: number,
			worktree?: string,
			createdAt = 0
		): BuildRecord => ({
			...rec(`${fp}:${jsKey}`, size, lastUsedAt),
			path: `/c/${fp}/simulator/repacks/${jsKey}/A.app`,
			kind: "simulator-repack",
			baseHash: `${fp}:base`,
			jsKey,
			createdAt,
			...(worktree !== undefined ? { worktree } : {}),
		}),
		dev: (fp: string, size: number, lastUsedAt: number): BuildRecord => ({
			...rec(`${fp}:dev`, size, lastUsedAt),
			path: `/c/${fp}/dev/A.app`,
			kind: "dev",
		}),
	};
	const hashes = (rows: readonly BuildRecord[]) => rows.map((b) => b.hash);

	test("a kind row's alias is recognised by its size 0, not by its dir name", () => {
		expect(isAlias(mk.dev("fp", 10, 1))).toBe(false);
		expect(isAlias({ ...mk.dev("fp", 10, 1), size: 0 })).toBe(true);
		expect(isAlias(rec("h", 1, 1))).toBe(false);
	});

	test("repacks go before a base that was used less recently", () => {
		const builds = [mk.base("fp", 100 * MB, 1), mk.repack("fp", "a", 10 * MB, 50), mk.repack("fp", "b", 10 * MB, 60)];
		const plan = planPrune(builds, 110 * MB, new Set());
		expect(hashes(plan.remove)).toEqual(["fp:a"]);
		expect(hashes(plan.keep)).toEqual(["fp:base", "fp:b"]);
	});

	test("repacks are removed least-recently-used first", () => {
		const builds = [
			mk.base("fp", 100 * MB, 1),
			mk.repack("fp", "new", 10 * MB, 90),
			mk.repack("fp", "old", 10 * MB, 10),
			mk.repack("fp", "mid", 10 * MB, 50),
		];
		expect(hashes(planPrune(builds, 115 * MB, new Set()).remove)).toEqual(["fp:old", "fp:mid"]);
	});

	test("the newest repack of each worktree is never removed", () => {
		const builds = [
			mk.base("fp", 100 * MB, 1),
			mk.repack("fp", "a-old", 10 * MB, 10, "/w/a", 1),
			mk.repack("fp", "a-new", 10 * MB, 20, "/w/a", 2),
			mk.repack("fp", "b-only", 10 * MB, 5, "/w/b", 3),
			mk.repack("fp", "anon", 10 * MB, 30),
		];
		const plan = planPrune(builds, 0, new Set());
		expect(hashes(plan.remove).sort()).toEqual(["fp:a-old", "fp:anon"]);
		expect(hashes(plan.keep).sort()).toEqual(["fp:a-new", "fp:b-only", "fp:base"]);
	});

	test("newest is per worktree across bases: another fingerprint's repack of the same worktree is not protected", () => {
		const builds = [
			mk.base("fp1", 10 * MB, 1),
			mk.base("fp2", 10 * MB, 1),
			mk.repack("fp1", "x", 10 * MB, 10, "/w/a", 1),
			mk.repack("fp2", "y", 10 * MB, 20, "/w/a", 2),
		];
		const plan = planPrune(builds, 0, new Set());
		expect(hashes(plan.keep).sort()).toEqual(["fp2:base", "fp2:y"]);
	});

	test("removing a base removes its repacks and counts their bytes", () => {
		const builds = [mk.base("fp", 100 * MB, 1), mk.repack("fp", "a", 10 * MB, 2), mk.dev("other", 50 * MB, 3)];
		const plan = planPrune(builds, 50 * MB, new Set());
		expect(hashes(plan.remove).sort()).toEqual(["fp:a", "fp:base"]);
		expect(plan.after).toBe(50 * MB);
		expect(hashes(plan.keep)).toEqual(["other:dev"]);
	});

	test("a base whose repack is protected stays", () => {
		const builds = [mk.base("fp", 100 * MB, 1), mk.repack("fp", "a", 10 * MB, 2, "/w/a")];
		const plan = planPrune(builds, 0, new Set());
		expect(plan.remove).toEqual([]);
	});

	test("a base with a repack whose build lock is held stays", () => {
		const builds = [mk.base("fp", 100 * MB, 1), mk.repack("fp", "a", 10 * MB, 2), mk.dev("o", MB, 3)];
		const byHash = planPrune(builds, 0, new Set([buildLockKey("k", "ios", "fp:a")]));
		expect(hashes(byHash.keep).sort()).toEqual(["fp:a", "fp:base"]);
		const byJsKey = planPrune(builds, 0, new Set([buildLockKey("k", "ios", "a")]));
		expect(hashes(byJsKey.keep).sort()).toEqual(["fp:a", "fp:base"]);
	});

	test("graceMs protects a recently used repack and so its base", () => {
		const builds = [mk.base("fp", 100 * MB, 1), mk.repack("fp", "a", 10 * MB, 95)];
		const plan = planPrune(builds, 0, new Set(), { now: 100, graceMs: 10 });
		expect(plan.remove).toEqual([]);
	});

	test("legacy rows behave as before next to kind rows", () => {
		const builds = [rec("legacy", 4 * GB, 1), mk.dev("fp", 4 * GB, 2)];
		expect(hashes(planPrune(builds, 5 * GB, new Set()).remove)).toEqual(["legacy"]);
	});
});

describe("pruneBuilds with repacks", () => {
	let dir: string;
	let store: Store;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-prune-kinds-"));
		store = openStore(join(dir, "warden.db"));
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("deletes a base's repacks from disk and store with it", () => {
		const env = { WARDEN_HOME: dir };
		const baseApp = fakeApp(join(dir, "builds", "k", "ios", "fp", "simulator", "base"));
		const repackApp = fakeApp(join(dir, "builds", "k", "ios", "fp", "simulator", "repacks", "j1"));
		upsertBuild(store, { ...rec("fp:base", 100, 1), path: baseApp, kind: "simulator-base" });
		recordRepack(store, {
			...rec("fp:j1", 10, 2),
			path: repackApp,
			kind: "simulator-repack",
			baseHash: "fp:base",
			jsKey: "j1",
		});
		pruneBuilds({ store, env, maxBytes: 0, now: 100, pidAlive: () => false });
		expect(listBuilds(store)).toEqual([]);
		expect(existsSync(baseApp)).toBe(false);
		expect(existsSync(repackApp)).toBe(false);
	});
});
