import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store";
import { fakeApp } from "./builds.testing";
import { aliasBuild, type BuildRecord, getInstall, listBuilds, recordInstall, storeArtifact } from "./cache";
import { buildLockKey, buildResource } from "./lock";
import { planRemove, removeBuilds } from "./remove";

function rec(hash: string, over: Partial<BuildRecord> = {}): BuildRecord {
	return {
		projectKey: "k",
		platform: "ios",
		profile: "p",
		hash,
		path: `/c/${hash}/A.app`,
		source: "build",
		size: 10,
		createdAt: 0,
		lastUsedAt: 0,
		...over,
	};
}

const NONE = new Set<string>();

describe("planRemove", () => {
	test("a unique prefix picks the build and its aliases", () => {
		const primary = rec("cd8e2dbeae5b");
		const alias = rec("ffff0000aaaa", { path: primary.path, size: 0 });
		const res = planRemove([primary, alias, rec("aaaa1111bbbb")], ["cd8e2d"], undefined, NONE);
		expect(res).toEqual({ success: true, data: [primary, alias] });
	});

	test("naming an alias removes the build it points at", () => {
		const primary = rec("cd8e2dbeae5b");
		const alias = rec("ffff0000aaaa", { path: primary.path, size: 0 });
		const res = planRemove([primary, alias], ["ffff0000"], undefined, NONE);
		expect(res.success && res.data.map((b) => b.hash)).toEqual(["cd8e2dbeae5b", "ffff0000aaaa"]);
	});

	test("too short, no match, ambiguous, build-locked → errors", () => {
		const builds = [rec("abcdef01"), rec("abcdef02"), rec("abcdef03", { platform: "android", path: "/c/x.apk" })];
		const msg = (prefixes: string[], platform?: "ios" | "android", locked = NONE) => {
			const res = planRemove(builds, prefixes, platform, locked);
			return res.success ? "" : res.error;
		};
		expect(msg(["abc"])).toContain("at least 6");
		expect(msg(["999999"])).toContain("no cached build matches 999999");
		expect(msg(["abcdef"])).toContain("matches 3 builds");
		expect(msg(["abcdef"], "android")).toBe("");
		expect(msg(["abcdef01"], undefined, new Set([buildLockKey("k", "ios", "abcdef01")]))).toContain(
			"being built or fetched"
		);
	});

	test("the same build named twice is removed once", () => {
		const res = planRemove([rec("abcdef01")], ["abcdef", "abcdef01"], undefined, NONE);
		expect(res.success && res.data).toHaveLength(1);
	});
});

describe("removeBuilds", () => {
	let dir: string;
	let store: Store;
	let env: Record<string, string>;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warden-remove-"));
		env = { WARDEN_HOME: join(dir, "home") };
		store = openStore(join(dir, "home", "warden.db"));
	});
	afterEach(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	async function seed(hash: string): Promise<BuildRecord> {
		const res = await storeArtifact({
			store,
			env,
			projectKey: "k",
			platform: "ios",
			profile: "p",
			hash,
			artifact: fakeApp(join(dir, "src", hash)),
			source: "build",
			now: 1,
		});
		if (!res.success) throw new Error(res.error);
		return res.data;
	}

	const install = (deviceId: string, hash: string) =>
		recordInstall(store, { platform: "ios", deviceId, bundleId: "com.x", hash, installedAt: 1 });

	test("deletes the files, its aliases and the install records at those hashes", async () => {
		const bad = await seed("cd8e2dbeae5b");
		const keep = await seed("aaaa1111bbbb");
		aliasBuild(store, bad, "ffff0000aaaa", 2);
		install("U1", "cd8e2dbeae5b");
		install("U2", "ffff0000aaaa");
		install("U3", "aaaa1111bbbb");
		const res = removeBuilds({ store, env, prefixes: ["cd8e2d"], now: 5, pidAlive: () => false });
		expect(res.success && res.data.forgotInstalls).toBe(2);
		expect(existsSync(bad.path)).toBe(false);
		expect(existsSync(keep.path)).toBe(true);
		expect(listBuilds(store).map((b) => b.hash)).toEqual(["aaaa1111bbbb"]);
		expect(getInstall(store, "ios", "U1", "com.x")).toBeUndefined();
		expect(getInstall(store, "ios", "U2", "com.x")).toBeUndefined();
		expect(getInstall(store, "ios", "U3", "com.x")?.hash).toBe("aaaa1111bbbb");
	});

	test("an alias whose build is already gone is removed by its own hash", async () => {
		const bad = await seed("cd8e2dbeae5b");
		aliasBuild(store, bad, "ffff0000aaaa", 2);
		store.db.query("DELETE FROM builds WHERE hash = ?").run("cd8e2dbeae5b");
		const res = removeBuilds({ store, env, prefixes: ["ffff0000"], now: 5, pidAlive: () => false });
		expect(res.success).toBe(true);
		expect(listBuilds(store)).toEqual([]);
	});

	test("dry run touches nothing", async () => {
		const bad = await seed("cd8e2dbeae5b");
		install("U1", "cd8e2dbeae5b");
		const res = removeBuilds({ store, env, prefixes: ["cd8e2d"], now: 5, pidAlive: () => false, dryRun: true });
		expect(res.success && res.data.remove.map((b) => b.hash)).toEqual(["cd8e2dbeae5b"]);
		expect(res.success && res.data.forgotInstalls).toBe(1);
		expect(existsSync(bad.path)).toBe(true);
		expect(getInstall(store, "ios", "U1", "com.x")).toBeDefined();
	});

	test("a build being built is refused", async () => {
		await seed("cd8e2dbeae5b");
		store.insertLease(
			{
				resource: buildResource(buildLockKey("k", "ios", "cd8e2dbeae5b")),
				owner: { kind: "ci", runId: "x" },
				ttlMs: 60_000,
			},
			1
		);
		const res = removeBuilds({ store, env, prefixes: ["cd8e2d"], now: 5, pidAlive: () => false });
		expect(res.success).toBe(false);
		expect(listBuilds(store)).toHaveLength(1);
	});
});
