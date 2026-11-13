import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store";
import { fakeApp } from "./builds.testing";
import { kindDir, storeArtifact } from "./cache";
import { devBuildHash, findDevBuild } from "./dev-build";

let dir: string;
let store: Store;
let env: Record<string, string>;
const KEY = "github.com/o/r:app";
const FP = "abc123";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "warden-dev-build-"));
	env = { WARDEN_HOME: join(dir, "home") };
	store = openStore(join(dir, "home", "warden.db"));
});
afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

async function seedDev(): Promise<string> {
	const res = await storeArtifact({
		store,
		env,
		projectKey: KEY,
		platform: "ios",
		profile: "local",
		hash: `${FP}:dev`,
		artifact: fakeApp(join(dir, "src")),
		source: "build",
		layout: { dir: kindDir(env, KEY, "ios", { kind: "dev", nativeFp: FP }), kind: "dev" },
		now: 1,
	});
	if (!res.success) throw new Error(res.error);
	return res.data.path;
}

async function seedPlain(): Promise<string> {
	const res = await storeArtifact({
		store,
		env,
		projectKey: KEY,
		platform: "ios",
		profile: "local",
		hash: FP,
		artifact: fakeApp(join(dir, "src")),
		source: "legacy",
		now: 1,
	});
	if (!res.success) throw new Error(res.error);
	return res.data.path;
}

describe("devBuildHash", () => {
	test("<fp> and <fp>:dev name the same dev build", () => {
		expect(devBuildHash(FP)).toEqual({ nativeFp: FP, hash: `${FP}:dev` });
		expect(devBuildHash(`${FP}:dev`)).toEqual({ nativeFp: FP, hash: `${FP}:dev` });
	});
});

describe("findDevBuild", () => {
	const query = { projectKey: KEY, platform: "ios", now: 5 } as const;

	test("finds a dev row by <fp>:dev or <fp>", async () => {
		const path = await seedDev();
		expect(findDevBuild(store, { ...query, hash: `${FP}:dev`, kindlessIsDev: true })?.path).toBe(path);
		expect(findDevBuild(store, { ...query, hash: FP, kindlessIsDev: false })?.path).toBe(path);
	});

	test("a legacy plain <fp> row is the dev build only when the project's plain build is the dev build", async () => {
		const path = await seedPlain();
		expect(findDevBuild(store, { ...query, hash: `${FP}:dev`, kindlessIsDev: true })?.path).toBe(path);
		expect(findDevBuild(store, { ...query, hash: `${FP}:dev`, kindlessIsDev: false })).toBeUndefined();
	});

	test("a miss is undefined; another kind's row at <fp> is never a dev build", async () => {
		expect(findDevBuild(store, { ...query, hash: `${FP}:dev`, kindlessIsDev: true })).toBeUndefined();
		await storeArtifact({
			store,
			env,
			projectKey: KEY,
			platform: "ios",
			profile: "local",
			hash: `${FP}:base`,
			artifact: fakeApp(join(dir, "src2")),
			source: "build",
			layout: { dir: kindDir(env, KEY, "ios", { kind: "simulator-base", nativeFp: FP }), kind: "simulator-base" },
			now: 1,
		});
		expect(findDevBuild(store, { ...query, hash: `${FP}:dev`, kindlessIsDev: true })).toBeUndefined();
	});
});
