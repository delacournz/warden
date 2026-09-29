import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store";
import { fakeApp } from "./builds.testing";
import {
	buildDir,
	cachedBuild,
	diskSize,
	findLegacyArtifact,
	forgetInstall,
	getBuild,
	getInstall,
	listBuilds,
	recordInstall,
	removeBuild,
	storeArtifact,
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
