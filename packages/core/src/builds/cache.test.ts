import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store";
import { fakeApp } from "./builds.testing";
import {
	aliasBuild,
	type BuildRecord,
	buildDir,
	buildKindOf,
	cachedBuild,
	devDir,
	diskSize,
	findLegacyArtifact,
	findRepack,
	findSimulatorBase,
	forgetInstall,
	getBuild,
	getInstall,
	kindDir,
	kindHash,
	listBuilds,
	recordInstall,
	recordRepack,
	releaseDir,
	removeBuild,
	repackDir,
	repacksOf,
	type SimulatorRepackRecord,
	simulatorBaseDir,
	storeArtifact,
	upsertBuild,
} from "./cache";

let dir: string;
let store: Store;
let env: Record<string, string>;
const KEY = "github.com/o/r:app";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-cache-"));
	env = { WARDEN_HOME: join(dir, "home") };
	store = openStore(join(dir, "home", "warden.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("storeArtifact / cachedBuild", () => {
	test("copies an .app into the cache and registers it", async () => {
		const src = fakeApp(join(dir, "src"));
		const res = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "development-simulator",
			hash: "h1",
			artifact: src,
			source: "import",
			now: 10,
		});
		if (!res.success) throw new Error(res.error);
		expect(res.data.path).toBe(join(buildDir(env, KEY, "ios", "h1"), "App.app"));
		expect(res.data.size).toBe(12);
		expect(existsSync(src)).toBe(true);
		expect(existsSync(join(res.data.path, "App"))).toBe(true);
		expect(getBuild(store, KEY, "ios", "h1")).toEqual(res.data);

		const hit = cachedBuild(store, KEY, "ios", "h1", 99);
		expect(hit?.lastUsedAt).toBe(99);
		expect(getBuild(store, KEY, "ios", "h1")?.lastUsedAt).toBe(99);
	});

	test("move=true moves the download", async () => {
		const src = join(dir, "dl", "app.apk");
		mkdirSync(join(dir, "dl"));
		writeFileSync(src, "apk");
		const res = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "android",
			profile: "p",
			hash: "h2",
			artifact: src,
			source: "eas",
			move: true,
			now: 1,
		});
		expect(res.success).toBe(true);
		expect(existsSync(src)).toBe(false);
	});

	test("an iOS simulator base is stored without the main.jsbundle Xcode left in the product", async () => {
		const src = fakeApp(join(dir, "src"));
		writeFileSync(join(src, "main.jsbundle"), "stale js");
		const layoutDir = simulatorBaseDir(env, KEY, "ios", "fp");
		const res = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "local",
			hash: "fp:base",
			artifact: src,
			source: "build",
			now: 1,
			layout: { dir: layoutDir, kind: "simulator-base" },
		});
		if (!res.success) throw new Error(res.error);
		expect(existsSync(join(res.data.path, "main.jsbundle"))).toBe(false);
		expect(existsSync(join(src, "main.jsbundle"))).toBe(true);
		expect(res.data.size).toBe(12);
	});

	test("wrong extension → error", async () => {
		const src = fakeApp(join(dir, "src"));
		const res = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "android",
			profile: "p",
			hash: "h",
			artifact: src,
			source: "import",
			now: 1,
		});
		expect(res.success).toBe(false);
	});

	test("record whose files vanished → miss + dropped", async () => {
		const src = fakeApp(join(dir, "src"));
		const res = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "p",
			hash: "h",
			artifact: src,
			source: "import",
			now: 1,
		});
		if (!res.success) throw new Error(res.error);
		rmSync(res.data.path, { recursive: true });
		expect(cachedBuild(store, KEY, "ios", "h", 2)).toBeUndefined();
		expect(listBuilds(store)).toEqual([]);
	});

	test("removeBuild deletes files + record", async () => {
		const res = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "p",
			hash: "h",
			artifact: fakeApp(join(dir, "src")),
			source: "import",
			now: 1,
		});
		if (!res.success) throw new Error(res.error);
		removeBuild(store, env, res.data);
		expect(existsSync(res.data.path)).toBe(false);
		expect(listBuilds(store)).toEqual([]);
	});
});

describe("legacy + installs + diskSize", () => {
	test("aliasBuild: a second key for the same files, counted once, touched with and removed with its primary", async () => {
		const stored = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "local",
			hash: "h1",
			artifact: fakeApp(join(dir, "src")),
			source: "build",
			now: 10,
		});
		if (!stored.success) throw new Error(stored.error);
		expect(aliasBuild(store, stored.data, "h2", 20)).toBe(true);
		expect(getBuild(store, KEY, "ios", "h2")).toMatchObject({ path: stored.data.path, size: 0, source: "build" });
		expect(listBuilds(store).reduce((sum, b) => sum + b.size, 0)).toBe(12);

		expect(cachedBuild(store, KEY, "ios", "h2", 30)?.path).toBe(stored.data.path);
		expect(getBuild(store, KEY, "ios", "h1")?.lastUsedAt).toBe(30);

		const primary = getBuild(store, KEY, "ios", "h1");
		if (!primary) throw new Error("no primary");
		removeBuild(store, env, primary);
		expect(listBuilds(store)).toEqual([]);
	});

	test("aliasBuild keeps an existing build of the alias key", async () => {
		const store1 = async (hash: string) => {
			const res = await storeArtifact({
				store,
				env,
				projectKey: KEY,
				platform: "ios",
				profile: "local",
				hash,
				artifact: fakeApp(join(dir, `src-${hash}`)),
				source: "build",
				now: 10,
			});
			if (!res.success) throw new Error(res.error);
			return res.data;
		};
		const h1 = await store1("h1");
		const h2 = await store1("h2");
		expect(aliasBuild(store, h1, "h2", 20)).toBe(false);
		expect(getBuild(store, KEY, "ios", "h2")?.path).toBe(h2.path);
		expect(aliasBuild(store, h1, "h1", 20)).toBe(false);
	});

	test("findLegacyArtifact looks for <dir>/<hash>/*.app", () => {
		const legacy = join(dir, "legacy");
		fakeApp(join(legacy, "abc"), "Salient.app");
		expect(findLegacyArtifact(["/nope", legacy], "ios", "abc")).toBe(join(legacy, "abc", "Salient.app"));
		expect(findLegacyArtifact([legacy], "ios", "zzz")).toBeUndefined();
		expect(findLegacyArtifact([legacy], "android", "abc")).toBeUndefined();
	});

	test("installs upsert per device + bundle", () => {
		recordInstall(store, { platform: "ios", deviceId: "U1", bundleId: "b", hash: "h1", installedAt: 1 });
		recordInstall(store, { platform: "ios", deviceId: "U1", bundleId: "b", hash: "h2", installedAt: 2 });
		expect(getInstall(store, "ios", "U1", "b")).toEqual({
			platform: "ios",
			deviceId: "U1",
			bundleId: "b",
			hash: "h2",
			installedAt: 2,
		});
		expect(getInstall(store, "ios", "U2", "b")).toBeUndefined();
		forgetInstall(store, "ios", "U1", "b");
		expect(getInstall(store, "ios", "U1", "b")).toBeUndefined();
	});

	test("diskSize sums files recursively; missing = 0", () => {
		expect(diskSize(fakeApp(dir))).toBe(12);
		expect(diskSize(join(dir, "missing"))).toBe(0);
	});
});

describe("kind layout", () => {
	test("dirs hang off the native fingerprint dir", () => {
		const root = buildDir(env, KEY, "ios", "fp1");
		expect(devDir(env, KEY, "ios", "fp1")).toBe(join(root, "dev"));
		expect(simulatorBaseDir(env, KEY, "ios", "fp1")).toBe(join(root, "simulator", "base"));
		expect(repackDir(env, KEY, "ios", "fp1", "js1")).toBe(join(root, "simulator", "repacks", "js1"));
		expect(releaseDir(env, KEY, "android", "fp1", "js1")).toBe(
			join(buildDir(env, KEY, "android", "fp1"), "release", "js1")
		);
	});

	test("hashes are distinct per kind; a repack is <nativeFp>:<jsKey>", () => {
		const hashes = [
			kindHash({ kind: "dev", nativeFp: "fp" }),
			kindHash({ kind: "simulator-base", nativeFp: "fp" }),
			kindHash({ kind: "simulator-repack", nativeFp: "fp", jsKey: "js" }),
			kindHash({ kind: "release", nativeFp: "fp", jsKey: "js" }),
		];
		expect(hashes).toEqual(["fp:dev", "fp:base", "fp:js", "fp:release:js"]);
		expect(new Set(hashes).size).toBe(4);
		expect(kindDir(env, KEY, "ios", { kind: "simulator-repack", nativeFp: "fp", jsKey: "js" })).toBe(
			repackDir(env, KEY, "ios", "fp", "js")
		);
	});
});

const base = (hash: string, path: string, size = 10) => ({
	projectKey: KEY,
	platform: "ios" as const,
	profile: "local",
	hash,
	path,
	source: "build" as const,
	size,
	createdAt: 1,
	lastUsedAt: 1,
});

describe("kind records", () => {
	test("every kind round-trips through the store; a row without a kind reads back as a legacy record", () => {
		const repack: SimulatorRepackRecord = {
			...base("fp:js", "/r/App.app"),
			kind: "simulator-repack",
			baseHash: "fp:base",
			jsKey: "js",
			worktree: "/w/a",
			branch: "feat/x",
		};
		const records: BuildRecord[] = [
			{ ...base("fp:dev", "/d/App.app"), kind: "dev" },
			{ ...base("fp:base", "/b/App.app"), kind: "simulator-base" },
			repack,
			{ ...base("fp:release:js", "/rel/App.app"), kind: "release", jsKey: "js" },
			base("old", "/o/App.app"),
		];
		for (const r of records) upsertBuild(store, r);
		for (const r of records) expect(getBuild(store, KEY, "ios", r.hash)).toEqual(r);
		expect(getBuild(store, KEY, "ios", "old")).not.toHaveProperty("kind");
		expect(records.map(buildKindOf)).toEqual(["dev", "simulator", "simulator", "release", undefined]);
	});

	test("a repack without worktree / branch has neither key", () => {
		recordRepack(store, { ...base("fp:js", "/r/App.app"), kind: "simulator-repack", baseHash: "fp:base", jsKey: "js" });
		const got = getBuild(store, KEY, "ios", "fp:js");
		expect(got).not.toHaveProperty("worktree");
		expect(got).not.toHaveProperty("branch");
	});

	test("findRepack / findSimulatorBase return a record whose files exist, drop one whose files are gone", () => {
		const baseApp = fakeApp(simulatorBaseDir(env, KEY, "ios", "fp"));
		const repackApp = fakeApp(repackDir(env, KEY, "ios", "fp", "js"));
		upsertBuild(store, { ...base("fp:base", baseApp), kind: "simulator-base" });
		recordRepack(store, {
			...base("fp:js", repackApp),
			kind: "simulator-repack",
			baseHash: "fp:base",
			jsKey: "js",
		});
		expect(findSimulatorBase(store, { projectKey: KEY, platform: "ios", nativeFp: "fp" })?.path).toBe(baseApp);
		expect(findRepack(store, { projectKey: KEY, platform: "ios", nativeFp: "fp", jsKey: "js" })?.path).toBe(repackApp);
		expect(findRepack(store, { projectKey: KEY, platform: "ios", nativeFp: "fp", jsKey: "other" })).toBeUndefined();
		expect(findRepack(store, { projectKey: KEY, platform: "android", nativeFp: "fp", jsKey: "js" })).toBeUndefined();
		rmSync(repackApp, { recursive: true });
		expect(findRepack(store, { projectKey: KEY, platform: "ios", nativeFp: "fp", jsKey: "js" })).toBeUndefined();
		expect(getBuild(store, KEY, "ios", "fp:js")).toBeUndefined();
	});

	test("find* does not return another kind's row under the same hash", () => {
		const app = fakeApp(join(dir, "x"));
		upsertBuild(store, { ...base("fp:base", app), kind: "dev" });
		expect(findSimulatorBase(store, { projectKey: KEY, platform: "ios", nativeFp: "fp" })).toBeUndefined();
	});

	test("repacksOf lists the repacks of one base", () => {
		const mk = (hash: string, baseHash: string): BuildRecord => ({
			...base(hash, `/r/${hash}`),
			kind: "simulator-repack",
			baseHash,
			jsKey: hash,
		});
		const all = [mk("a", "b1"), mk("b", "b2"), { ...base("b1", "/b"), kind: "simulator-base" as const }];
		expect(repacksOf(all, KEY, "ios", "b1").map((r) => r.hash)).toEqual(["a"]);
	});
});

describe("storeArtifact into a kind dir", () => {
	test("layout dev: copies under the kind dir and records the kind", async () => {
		const src = fakeApp(join(dir, "src"));
		const target = devDir(env, KEY, "ios", "fp");
		const res = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "local:dev",
			hash: kindHash({ kind: "dev", nativeFp: "fp" }),
			artifact: src,
			source: "build",
			layout: { dir: target, kind: "dev" },
			now: 5,
		});
		if (!res.success) throw new Error(res.error);
		expect(res.data).toMatchObject({ kind: "dev", hash: "fp:dev", path: join(target, "App.app") });
		expect(existsSync(join(target, "App.app", "App"))).toBe(true);
		expect(getBuild(store, KEY, "ios", "fp:dev")).toEqual(res.data);
	});

	test("layout release carries the jsKey", async () => {
		const src = fakeApp(join(dir, "src"));
		const res = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "local",
			hash: "fp:release:js",
			artifact: src,
			source: "build",
			layout: { dir: releaseDir(env, KEY, "ios", "fp", "js"), kind: { kind: "release", jsKey: "js" } },
			now: 5,
		});
		if (!res.success) throw new Error(res.error);
		expect(res.data).toMatchObject({ kind: "release", jsKey: "js" });
	});
});

describe("removeBuild across kinds", () => {
	async function legacyAndKinds() {
		const legacy = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "p",
			hash: "fp",
			artifact: fakeApp(join(dir, "src")),
			source: "build",
			now: 1,
		});
		if (!legacy.success) throw new Error(legacy.error);
		const dev = fakeApp(devDir(env, KEY, "ios", "fp"));
		upsertBuild(store, { ...base("fp:dev", dev), kind: "dev" });
		return { legacy: legacy.data, dev };
	}

	test("removing a legacy build leaves the kind dirs of its fingerprint", async () => {
		const { legacy, dev } = await legacyAndKinds();
		removeBuild(store, env, legacy);
		expect(existsSync(legacy.path)).toBe(false);
		expect(existsSync(dev)).toBe(true);
		expect(getBuild(store, KEY, "ios", "fp")).toBeUndefined();
		expect(getBuild(store, KEY, "ios", "fp:dev")).toBeDefined();
	});

	test("removing a legacy build with nothing beside it removes its dir", async () => {
		const res = await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "p",
			hash: "solo",
			artifact: fakeApp(join(dir, "src2")),
			source: "build",
			now: 1,
		});
		if (!res.success) throw new Error(res.error);
		removeBuild(store, env, res.data);
		expect(existsSync(buildDir(env, KEY, "ios", "solo"))).toBe(false);
	});

	test("removing a kind build removes its own dir only", async () => {
		const { legacy, dev } = await legacyAndKinds();
		removeBuild(store, env, { ...base("fp:dev", dev), kind: "dev" });
		expect(existsSync(dev)).toBe(false);
		expect(existsSync(legacy.path)).toBe(true);
	});

	test("removing a simulator base takes its repacks (files + rows) with it", () => {
		const baseApp = fakeApp(simulatorBaseDir(env, KEY, "ios", "fp"));
		const r1 = fakeApp(repackDir(env, KEY, "ios", "fp", "j1"));
		const r2 = fakeApp(repackDir(env, KEY, "ios", "fp", "j2"));
		const baseRecord: BuildRecord = { ...base("fp:base", baseApp), kind: "simulator-base" };
		upsertBuild(store, baseRecord);
		for (const [hash, path, jsKey] of [
			["fp:j1", r1, "j1"],
			["fp:j2", r2, "j2"],
		] as const) {
			recordRepack(store, { ...base(hash, path), kind: "simulator-repack", baseHash: "fp:base", jsKey });
		}
		upsertBuild(store, {
			...base("fp:j9", "/elsewhere/App.app"),
			kind: "simulator-repack",
			baseHash: "fp:other",
			jsKey: "j9",
		});
		removeBuild(store, env, baseRecord);
		expect(existsSync(baseApp)).toBe(false);
		expect(existsSync(r1)).toBe(false);
		expect(existsSync(r2)).toBe(false);
		expect(listBuilds(store).map((b) => b.hash)).toEqual(["fp:j9"]);
	});
});
